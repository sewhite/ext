import papi, { logger } from '@papi/backend';
import type {
  ExecutionActivationContext,
  IWebViewProvider,
  OpenWebViewOptions,
  SavedWebViewDefinition,
  WebViewDefinition,
} from '@papi/core';
import type {
  ProjectListEntry,
  ProjectPermissionType,
  ProjectRolesPermissionsResult,
  ProjectUserChangeSet,
} from 'project-user-roles';
import projectUserRolesWebView from './project-user-roles.web-view?inline';
import projectUserRolesStyles from './project-user-roles.scss?inline';

const reactWebViewType = 'projectUserRoles.react';

/**
 * Runs `assets/project-scanner.js` in its own, unrestricted Node process (using the `createProcess`
 * elevated privilege) and returns its parsed JSON result. If `stdinData` is given, it is written to
 * the process's stdin (used for payloads too large to pass safely on the command line, such as a
 * whole change set).
 *
 * We use a fresh, short-lived child process per call rather than a persistent one: these are
 * infrequent, user-triggered lookups, so the simplicity of "fork, collect stdout, done" easily
 * outweighs the small cost of spawning a process each time.
 */
function runScanner(
  context: ExecutionActivationContext,
  args: string[],
  stdinData?: string,
): Promise<unknown> {
  const { createProcess } = context.elevatedPrivileges;
  if (!createProcess)
    throw new Error('Forgot to add "createProcess" to "elevatedPrivileges" in manifest.json');

  return new Promise((resolve, reject) => {
    const child = createProcess.fork(context.executionToken, 'assets/project-scanner.js', args, {
      silent: true,
    });

    // Never leave the caller (and the UI's "Saving..." state) waiting forever if the helper
    // process gets stuck for any reason.
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        // already gone
      }
      reject(new Error(`project-scanner.js ${args[0]} timed out after 60 seconds`));
    }, 60_000);
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (e) => settle(() => reject(e)));

    if (stdinData !== undefined) {
      // Send the payload every way we can; the scanner uses whichever arrives first. IPC is the
      // most reliable on Windows, stdin is the fallback (see `receivePayloadJson` in the scanner).
      let sentSomehow = false;
      try {
        if (typeof child.send === 'function' && child.connected) {
          child.send(stdinData);
          sentSomehow = true;
        }
      } catch (e) {
        logger.warn(`Could not send change set to project-scanner.js over IPC: ${e}`);
      }
      if (child.stdin) {
        child.stdin.on('error', (e) => {
          logger.warn(`Could not send change set to project-scanner.js over stdin: ${e}`);
        });
        try {
          child.stdin.end(stdinData, 'utf8');
          sentSomehow = true;
        } catch (e) {
          logger.warn(`Could not write change set to project-scanner.js stdin: ${e}`);
        }
      }
      if (!sentSomehow) {
        settle(() => {
          try {
            child.kill();
          } catch {
            // already gone
          }
          reject(
            new Error('Could not send the change set to project-scanner.js (no IPC or stdin)'),
          );
        });
        return;
      }
    }

    child.on('close', (code) => {
      if (stderr) logger.warn(`project-scanner.js stderr: ${stderr}`);
      settle(() => {
        if (!stdout.trim()) {
          reject(new Error(`project-scanner.js produced no output (exit code ${code})`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          if (parsed && typeof parsed === 'object' && 'error' in parsed) {
            reject(new Error(String((parsed as { error: unknown }).error)));
            return;
          }
          resolve(parsed);
        } catch (e) {
          reject(new Error(`Failed to parse project-scanner.js output: ${e}\nOutput: ${stdout}`));
        }
      });
    });
  });
}

/**
 * Reads a project's roles/permissions and combines them with whether the current Paratext user on
 * this computer is that project's Administrator, by matching the registered user name (see
 * `getCurrentUserName` in `assets/project-scanner.js`) against the project's own user list.
 */
async function getRolesPermissionsWithCurrentUser(
  context: ExecutionActivationContext,
  projectPath: string,
): Promise<ProjectRolesPermissionsResult> {
  const [result, whoami] = await Promise.all([
    runScanner(context, ['get', projectPath]) as Promise<
      Omit<ProjectRolesPermissionsResult, 'currentUserName' | 'currentUserIsAdministrator'>
    >,
    runScanner(context, ['whoami']) as Promise<{ name?: string }>,
  ]);
  const currentUserName = whoami.name;
  const currentUser = currentUserName
    ? result.users.find((user) => user.userName === currentUserName)
    : undefined;
  return {
    ...result,
    currentUserName,
    currentUserIsAdministrator: currentUser?.role === 'Administrator',
  };
}

/**
 * Runs `performWrite` (a scanner action that edits ProjectUserAccess.xml) only if the current
 * Paratext user is this project's Administrator, then returns freshly re-read roles/permissions.
 * Re-verifies administrator status here rather than trusting the caller, since the UI's own check
 * is only there to decide what to render - this is what actually authorizes the write to disk.
 */
async function withAdministratorCheck(
  context: ExecutionActivationContext,
  projectPath: string,
  performWrite: () => Promise<unknown>,
): Promise<ProjectRolesPermissionsResult> {
  const current = await getRolesPermissionsWithCurrentUser(context, projectPath);
  if (!current.currentUserIsAdministrator)
    throw new Error("Only this project's Administrator can change user permissions.");

  await performWrite();
  return getRolesPermissionsWithCurrentUser(context, projectPath);
}

interface ProjectUserRolesWebViewOptions extends OpenWebViewOptions {
  /** The project this view should show roles/permissions for, if opened for a specific project */
  projectId?: string;
}

const reactWebViewProvider: IWebViewProvider = {
  async getWebView(
    savedWebView: SavedWebViewDefinition,
    getWebViewOptions: ProjectUserRolesWebViewOptions,
  ): Promise<WebViewDefinition | undefined> {
    if (savedWebView.webViewType !== reactWebViewType)
      throw new Error(
        `${reactWebViewType} provider received request to provide a ${savedWebView.webViewType} WebView`,
      );
    const projectId = getWebViewOptions.projectId ?? savedWebView.projectId ?? undefined;
    return {
      ...savedWebView,
      title: 'Project User Roles',
      content: projectUserRolesWebView,
      styles: projectUserRolesStyles,
      projectId,
    };
  },
};

export async function activate(context: ExecutionActivationContext): Promise<void> {
  logger.info('Project User Roles extension is activating!');

  const reactWebViewProviderPromise = papi.webViewProviders.registerWebViewProvider(
    reactWebViewType,
    reactWebViewProvider,
  );

  const listProjectsCommandPromise = papi.commands.registerCommand(
    'projectUserRoles.listProjects',
    async () => (await runScanner(context, ['list'])) as ProjectListEntry[],
  );

  const getRolesPermissionsCommandPromise = papi.commands.registerCommand(
    'projectUserRoles.getRolesPermissions',
    async (projectPath: string) => getRolesPermissionsWithCurrentUser(context, projectPath),
  );

  const setUserPermissionCommandPromise = papi.commands.registerCommand(
    'projectUserRoles.setUserPermission',
    async (
      projectPath: string,
      userName: string,
      permissionType: ProjectPermissionType,
      granted: boolean,
    ) =>
      withAdministratorCheck(context, projectPath, () =>
        runScanner(context, [
          'set',
          projectPath,
          userName,
          permissionType,
          granted ? 'true' : 'false',
        ]),
      ),
  );

  const setUserAllBooksCommandPromise = papi.commands.registerCommand(
    'projectUserRoles.setUserAllBooks',
    async (projectPath: string, userName: string, allBooks: boolean) =>
      withAdministratorCheck(context, projectPath, () =>
        runScanner(context, ['setAllBooks', projectPath, userName, allBooks ? 'true' : 'false']),
      ),
  );

  const setUserBookCommandPromise = papi.commands.registerCommand(
    'projectUserRoles.setUserBook',
    async (projectPath: string, userName: string, bookId: string, granted: boolean) =>
      withAdministratorCheck(context, projectPath, () =>
        runScanner(context, ['setBook', projectPath, userName, bookId, granted ? 'true' : 'false']),
      ),
  );

  const applyChangesCommandPromise = papi.commands.registerCommand(
    'projectUserRoles.applyChanges',
    async (projectPath: string, changes: ProjectUserChangeSet) => {
      // The scanner also needs to know who is making the change, so it can refuse a change set that
      // would remove or demote them - it can't tell on its own, since only the `whoami` lookup
      // (done inside getRolesPermissionsWithCurrentUser) knows the current user.
      const current = await getRolesPermissionsWithCurrentUser(context, projectPath);
      if (!current.currentUserIsAdministrator)
        throw new Error("Only this project's Administrator can change user permissions.");
      const payload = JSON.stringify({ ...changes, currentUserName: current.currentUserName });
      await runScanner(context, ['apply', projectPath], payload);
      return getRolesPermissionsWithCurrentUser(context, projectPath);
    },
  );

  const resolveProjectPathCommandPromise = papi.commands.registerCommand(
    'projectUserRoles.resolveProjectPath',
    async (projectId: string) => {
      const projectName = await (
        await papi.projectDataProviders.get('platform.base', projectId)
      ).getSetting('platform.name');
      if (!projectName) return undefined;
      const projects = (await runScanner(context, ['list'])) as ProjectListEntry[];
      return projects.find((project) => project.id === projectName)?.path;
    },
  );

  // Registered as the "Project User Roles..." item in a project web view's Project menu.
  // Platform.Bible invokes menu commands with the id of the web view whose menu was clicked, so
  // we can look up that web view's project. If no project can be inferred (e.g. the command was
  // run some other way), fall back to asking the user to pick one.
  const openForActiveProjectCommandPromise = papi.commands.registerCommand(
    'projectUserRoles.openForActiveProject',
    async (webViewId?: string) => {
      let projectId: string | undefined;
      if (webViewId) {
        const webViewDefinition = await papi.webViews.getOpenWebViewDefinition(webViewId);
        projectId = webViewDefinition?.projectId;
      }
      if (!projectId) {
        projectId = await papi.dialogs.selectProject({
          title: 'Open Project User Roles',
          prompt: 'Choose a project to view its user roles and permissions:',
        });
      }
      if (!projectId) return undefined;

      const options: ProjectUserRolesWebViewOptions = { projectId };
      return papi.webViews.openWebView(reactWebViewType, undefined, options);
    },
  );

  context.registrations.add(
    await reactWebViewProviderPromise,
    await listProjectsCommandPromise,
    await getRolesPermissionsCommandPromise,
    await setUserPermissionCommandPromise,
    await setUserAllBooksCommandPromise,
    await setUserBookCommandPromise,
    await applyChangesCommandPromise,
    await resolveProjectPathCommandPromise,
    await openForActiveProjectCommandPromise,
  );

  logger.info('Project User Roles extension is finished activating!');
}

export async function deactivate() {
  logger.debug('Project User Roles extension is deactivating!');
  return true;
}
