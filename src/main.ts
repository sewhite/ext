import papi, { logger } from '@papi/backend';
import type {
  ExecutionActivationContext,
  IWebViewProvider,
  SavedWebViewDefinition,
  WebViewDefinition,
} from '@papi/core';
import type { ProjectListEntry, ProjectRolesPermissionsResult } from 'project-user-roles';
import projectUserRolesWebView from './project-user-roles.web-view?inline';
import projectUserRolesStyles from './project-user-roles.scss?inline';

const reactWebViewType = 'projectUserRoles.react';

/**
 * Runs `assets/project-scanner.js` in its own, unrestricted Node process (using the
 * `createProcess` elevated privilege) and returns its parsed JSON result.
 *
 * We use a fresh, short-lived child process per call rather than a persistent one: these are
 * infrequent, user-triggered lookups, so the simplicity of "fork, collect stdout, done" easily
 * outweighs the small cost of spawning a process each time.
 */
function runScanner(
  context: ExecutionActivationContext,
  args: string[],
): Promise<unknown> {
  const { createProcess } = context.elevatedPrivileges;
  if (!createProcess)
    throw new Error('Forgot to add "createProcess" to "elevatedPrivileges" in manifest.json');

  return new Promise((resolve, reject) => {
    const child = createProcess.fork(context.executionToken, 'assets/project-scanner.js', args, {
      silent: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (stderr) logger.warn(`project-scanner.js stderr: ${stderr}`);
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
}

const reactWebViewProvider: IWebViewProvider = {
  async getWebView(
    savedWebView: SavedWebViewDefinition,
  ): Promise<WebViewDefinition | undefined> {
    if (savedWebView.webViewType !== reactWebViewType)
      throw new Error(
        `${reactWebViewType} provider received request to provide a ${savedWebView.webViewType} WebView`,
      );
    return {
      ...savedWebView,
      title: 'Project User Roles',
      content: projectUserRolesWebView,
      styles: projectUserRolesStyles,
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
    async (projectPath: string) =>
      (await runScanner(context, ['get', projectPath])) as ProjectRolesPermissionsResult,
  );

  papi.webViews.openWebView(reactWebViewType, undefined, { existingId: '?' });

  context.registrations.add(
    await reactWebViewProviderPromise,
    await listProjectsCommandPromise,
    await getRolesPermissionsCommandPromise,
  );

  logger.info('Project User Roles extension is finished activating!');
}

export async function deactivate() {
  logger.debug('Project User Roles extension is deactivating!');
  return true;
}
