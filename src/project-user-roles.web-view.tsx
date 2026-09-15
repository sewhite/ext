import type { WebViewProps } from '@papi/core';
import papi, { logger } from '@papi/frontend';
import {
  Badge,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from 'platform-bible-react';
import type {
  ProjectPermissionType,
  ProjectListEntry,
  ProjectRolesPermissionsResult,
  ProjectUserDraft,
  ProjectUserInfo,
} from 'project-user-roles';
import { useEffect, useMemo, useRef, useState } from 'react';

const PERMISSION_TYPES: ProjectPermissionType[] = [
  'TermsList',
  'Renderings',
  'Spellings',
  'Passages',
  'Progress',
];

const PERMISSION_LABELS: Record<ProjectPermissionType, string> = {
  TermsList: 'Terms List',
  Renderings: 'Renderings',
  Spellings: 'Spellings',
  Passages: 'Passages',
  Progress: 'Progress',
};

/**
 * One row of the Administrator's editable draft. Edits are made to these locally and only written
 * to disk when the Administrator clicks Save (or thrown away with Cancel).
 */
type DraftUser = ProjectUserDraft & {
  firstUser: boolean;
  /** Added in this draft - not yet in the project on disk */
  isNew: boolean;
  /** Marked for removal in this draft - still shown (struck through) so it can be undone */
  removed: boolean;
};

function toDraft(users: ProjectUserInfo[]): DraftUser[] {
  return users.map((user) => ({
    userName: user.userName,
    role: user.role,
    unregisteredUser: user.unregisteredUser,
    allBooks: user.allBooks,
    books: [...user.books],
    permissions: { ...user.permissions },
    firstUser: user.firstUser,
    isNew: false,
    removed: false,
  }));
}

/**
 * A canonical form of a draft for change detection: every permission type spelled out as a boolean
 * (a permission missing from the file means the same as one explicitly not granted), in a fixed
 * order, so toggling something on and back off again counts as "no change".
 */
function normalizeForCompare(draft: DraftUser[]) {
  return draft.map((user) => ({
    userName: user.userName,
    role: user.role,
    allBooks: user.allBooks,
    books: user.books,
    permissions: PERMISSION_TYPES.map((type) => user.permissions[type] === true),
    removed: user.removed,
  }));
}

/**
 * The in-progress draft as kept in Platform.Bible's web view state, which survives the web view
 * being re-created (Platform.Bible re-mounts web views at various moments - re-layout, focus
 * changes, restarts - and plain React state is lost each time, which would silently throw away
 * unsaved edits). Tagged with the project path so a draft is never applied to a different project.
 */
type PersistedDraft = {
  projectPath: string;
  users: DraftUser[];
};

/** Strips draft-only bookkeeping and dropped users, producing what the Save command expects */
function toChangeSet(draft: DraftUser[]): ProjectUserDraft[] {
  return draft
    .filter((user) => !user.removed)
    .map(({ userName, role, unregisteredUser, allBooks, books, permissions }) => ({
      userName,
      role,
      unregisteredUser,
      allBooks,
      books,
      permissions,
    }));
}

/**
 * Shows a user's book access as read-only text, or - when `editable` - as an "All books" switch
 * plus a clickable badge per book an Administrator can use to grant/revoke individual books (this
 * is the permission that changes most often, so it gets one click per book rather than a menu).
 */
function BookAccess({
  allBooks,
  books,
  editable,
  availableBookIds,
  onToggleAllBooks,
  onToggleBook,
}: {
  allBooks: boolean;
  books: string[];
  editable: boolean;
  /** Every book id known to exist in this project, to offer as toggles */
  availableBookIds: string[];
  onToggleAllBooks?: (allBooks: boolean) => void;
  onToggleBook?: (bookId: string, granted: boolean) => void;
}) {
  if (!editable) {
    if (allBooks) return <span>All books</span>;
    if (books.length === 0) return <span className="tw:text-muted-foreground">No books</span>;
    return (
      <span title={books.join(', ')}>
        {books.length} book{books.length === 1 ? '' : 's'}
      </span>
    );
  }

  const grantedBookIds = new Set(books);

  return (
    <div className="tw:flex tw:flex-col tw:gap-1.5">
      <span className="tw:flex tw:items-center tw:gap-2 tw:text-sm">
        <Switch
          aria-label="All books"
          checked={allBooks}
          onCheckedChange={(checked) => onToggleAllBooks?.(checked)}
        />
        All books
      </span>
      {!allBooks &&
        (availableBookIds.length > 0 ? (
          <div className="tw:flex tw:max-w-xs tw:flex-wrap tw:gap-1">
            {availableBookIds.map((bookId) => {
              const granted = grantedBookIds.has(bookId);
              return (
                <button
                  key={bookId}
                  type="button"
                  onClick={() => onToggleBook?.(bookId, !granted)}
                  className={`tw:cursor-pointer tw:rounded-full tw:border tw:px-2.5 tw:py-0.5 tw:text-xs tw:font-semibold tw:transition-colors ${
                    granted
                      ? 'tw:border-transparent tw:bg-primary tw:text-primary-foreground'
                      : 'tw:text-muted-foreground tw:hover:bg-accent tw:hover:text-accent-foreground'
                  }`}
                >
                  {bookId}
                </button>
              );
            })}
          </div>
        ) : (
          <span className="tw:text-muted-foreground tw:text-xs">
            No specific books known for this project yet
          </span>
        ))}
    </div>
  );
}

/**
 * Shows a user's granted permissions as read-only badges, or - when `editable` - as toggleable
 * switches an Administrator can use to change them.
 */
function Permissions({
  permissions,
  editable,
  onToggle,
}: {
  permissions: { [key in ProjectPermissionType]?: boolean };
  editable: boolean;
  onToggle?: (permissionType: ProjectPermissionType, granted: boolean) => void;
}) {
  if (!editable) {
    return (
      <div className="tw:flex tw:flex-wrap tw:gap-1">
        {PERMISSION_TYPES.map((type) => {
          const granted = permissions[type] === true;
          return (
            <Badge
              key={type}
              variant={granted ? 'default' : 'outline'}
              className={granted ? '' : 'tw:text-muted-foreground'}
            >
              {PERMISSION_LABELS[type]}
            </Badge>
          );
        })}
      </div>
    );
  }

  return (
    <div className="tw:flex tw:flex-col tw:gap-1.5">
      {PERMISSION_TYPES.map((type) => (
        <span key={type} className="tw:flex tw:items-center tw:gap-2 tw:text-sm">
          <Switch
            aria-label={PERMISSION_LABELS[type]}
            checked={permissions[type] === true}
            onCheckedChange={(checked) => onToggle?.(type, checked)}
          />
          {PERMISSION_LABELS[type]}
        </span>
      ))}
    </div>
  );
}

/** Opens the project's Members page on the Paratext Registry in the user's browser */
async function openRegistryMembers(registryId: string) {
  const url = `https://registry.paratext.org/projects/${encodeURIComponent(registryId)}#members`;
  try {
    await papi.commands.sendCommand('platform.openWindow', url);
  } catch (e) {
    logger.warn(`Could not open ${url}: ${e}`);
    window.open(url, '_blank', 'noopener');
  }
}

globalThis.webViewComponent = function ProjectUserRoles({
  projectId,
  useWebViewState,
}: WebViewProps) {
  // Persisted across re-mounts of this web view (see PersistedDraft). `selectedPath` is persisted
  // too so a re-mount lands back on the same project without a round trip.
  const [persistedPath, setPersistedPath] = useWebViewState<string | undefined>(
    'selectedPath',
    undefined,
  );
  const [persistedDraft, setPersistedDraft, resetPersistedDraft] = useWebViewState<
    PersistedDraft | undefined
  >('draft', undefined);

  const [projects, setProjects] = useState<ProjectListEntry[] | undefined>(undefined);
  const [selectedPath, setSelectedPathState] = useState<string | undefined>(persistedPath);
  const [rolesData, setRolesData] = useState<ProjectRolesPermissionsResult | undefined>(undefined);
  const [draft, setDraftState] = useState<DraftUser[] | undefined>(undefined);

  // Keep the persisted copies in step with the live state. The persisted draft is what a re-mounted
  // view restores from, so every draft change goes through here.
  const setSelectedPath = (path: string | undefined) => {
    setSelectedPathState(path);
    setPersistedPath(path);
  };
  const draftRef = useRef<DraftUser[] | undefined>(undefined);
  /** Set while a save's freshly re-read data is arriving, so the old draft isn't restored over it */
  const justSavedRef = useRef(false);
  const setDraft = (
    update:
      DraftUser[] | undefined | ((current: DraftUser[] | undefined) => DraftUser[] | undefined),
  ) => {
    const next = typeof update === 'function' ? update(draftRef.current) : update;
    draftRef.current = next;
    setDraftState(next);
    if (next && selectedPath) setPersistedDraft({ projectPath: selectedPath, users: next });
    else resetPersistedDraft();
  };

  useEffect(() => {
    logger.info(
      `Project User Roles web view mounted (project ${selectedPath ?? 'none'}, persisted draft: ${
        persistedDraft ? `${persistedDraft.users.length} users` : 'none'
      })`,
    );
  }, []);
  const [listError, setListError] = useState<string | undefined>(undefined);
  const [rolesError, setRolesError] = useState<string | undefined>(undefined);
  const [activeProjectError, setActiveProjectError] = useState<string | undefined>(undefined);
  const [isLoadingRoles, setIsLoadingRoles] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [savedMessage, setSavedMessage] = useState<string | undefined>(undefined);

  async function loadProjects() {
    setListError(undefined);
    setProjects(undefined);
    try {
      const found = await papi.commands.sendCommand('projectUserRoles.listProjects');
      setProjects(found);
      // A remembered selection may point at a location we no longer prefer (e.g. Paratext 9's copy
      // of a project when Paratext 10 Studio has its own) - move it to the current path for the
      // same project, or forget it if the project is gone.
      const remembered = persistedPath;
      if (remembered && !found.some((project) => project.path === remembered)) {
        const sameProject = found.find((project) => project.id === remembered.split(/[\\/]/).pop());
        setSelectedPath(sameProject?.path);
      }
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    loadProjects();
  }, []);

  // This web view was opened for a specific project (e.g. from that project's Project menu) -
  // resolve it to its on-disk path and select it, so its roles show without the user having to
  // pick it manually from the dropdown.
  useEffect(() => {
    if (!projectId || selectedPath) return;
    setActiveProjectError(undefined);
    papi.commands
      .sendCommand('projectUserRoles.resolveProjectPath', projectId)
      .then((path) =>
        path
          ? setSelectedPath(path)
          : setActiveProjectError('Could not find this project on disk.'),
      )
      .catch((e) => setActiveProjectError(e instanceof Error ? e.message : String(e)));
  }, [projectId]);

  useEffect(() => {
    if (!selectedPath) {
      setRolesData(undefined);
      return;
    }
    setRolesError(undefined);
    setSaveError(undefined);
    setSavedMessage(undefined);
    setRolesData(undefined);
    setIsLoadingRoles(true);
    papi.commands
      .sendCommand('projectUserRoles.getRolesPermissions', selectedPath)
      .then((result) => setRolesData(result))
      .catch((e) => setRolesError(e instanceof Error ? e.message : String(e)))
      .finally(() => setIsLoadingRoles(false));
  }, [selectedPath]);

  // Whenever what's on disk (re)loads, start a fresh draft from it - unless this web view was just
  // re-mounted mid-edit, in which case pick the persisted draft for this project back up.
  useEffect(() => {
    if (!rolesData) {
      draftRef.current = undefined;
      setDraftState(undefined);
      return;
    }
    if (
      !justSavedRef.current &&
      persistedDraft &&
      persistedDraft.projectPath === selectedPath &&
      draftRef.current === undefined
    ) {
      logger.info('Project User Roles: restoring unsaved draft after re-mount');
      draftRef.current = persistedDraft.users;
      setDraftState(persistedDraft.users);
      return;
    }
    justSavedRef.current = false;
    setDraft(toDraft(rolesData.users));
  }, [rolesData]);

  const isAdministrator = rolesData?.currentUserIsAdministrator === true;
  const baseline = useMemo(() => (rolesData ? toDraft(rolesData.users) : undefined), [rolesData]);
  const isDirty =
    draft !== undefined &&
    baseline !== undefined &&
    JSON.stringify(normalizeForCompare(draft)) !== JSON.stringify(normalizeForCompare(baseline));

  /** Applies `update` to the one draft user named `userName` */
  function updateDraftUser(userName: string, update: (user: DraftUser) => DraftUser) {
    setSavedMessage(undefined);
    setDraft((current) =>
      current?.map((user) => (user.userName === userName ? update(user) : user)),
    );
  }

  function handleTogglePermission(
    userName: string,
    permissionType: ProjectPermissionType,
    granted: boolean,
  ) {
    updateDraftUser(userName, (user) => ({
      ...user,
      permissions: { ...user.permissions, [permissionType]: granted },
    }));
  }

  function handleToggleAllBooks(userName: string, allBooks: boolean) {
    updateDraftUser(userName, (user) => ({ ...user, allBooks }));
  }

  function handleToggleBook(userName: string, bookId: string, granted: boolean) {
    const projectOrder = rolesData?.allProjectBookIds ?? [];
    updateDraftUser(userName, (user) => {
      const books = new Set(user.books);
      if (granted) books.add(bookId);
      else books.delete(bookId);
      // Keep the list in project (canon) order, so what gets written to disk is tidy
      const ordered = projectOrder.filter((id) => books.has(id));
      const unknown = [...books].filter((id) => !projectOrder.includes(id));
      return { ...user, books: [...ordered, ...unknown] };
    });
  }

  function handleChangeRole(userName: string, role: string) {
    updateDraftUser(userName, (user) => ({ ...user, role }));
  }

  function handleSetRemoved(userName: string, removed: boolean) {
    setSavedMessage(undefined);
    setDraft((current) => {
      if (!current) return current;
      // A user added in this same draft can simply be dropped again rather than struck through
      if (removed && current.some((user) => user.userName === userName && user.isNew))
        return current.filter((user) => user.userName !== userName);
      return current.map((user) => (user.userName === userName ? { ...user, removed } : user));
    });
  }

  function handleCancel() {
    setSaveError(undefined);
    setSavedMessage(undefined);
    setDraft(baseline ? baseline.map((user) => ({ ...user })) : undefined);
  }

  async function handleSave() {
    if (!selectedPath || !draft) return;
    setSaveError(undefined);
    setSavedMessage(undefined);
    setIsSaving(true);
    try {
      const updated = await papi.commands.sendCommand(
        'projectUserRoles.applyChanges',
        selectedPath,
        {
          users: toChangeSet(draft),
        },
      );
      draftRef.current = undefined;
      justSavedRef.current = true;
      resetPersistedDraft();
      setRolesData(updated);
      setSavedMessage('Changes saved.');
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsSaving(false);
    }
  }

  const usersToShow: DraftUser[] =
    isAdministrator && draft ? draft : toDraft(rolesData?.users ?? []);

  return (
    <div className="pr-twp tw:flex tw:flex-col tw:gap-4 tw:p-6">
      <div className="tw:text-2xl tw:font-semibold tw:tracking-tight">Project User Roles</div>

      <div className="tw:flex tw:items-center tw:gap-3">
        <Select value={selectedPath} onValueChange={setSelectedPath} disabled={isDirty || isSaving}>
          <SelectTrigger className="pr-twp tw:w-64">
            <SelectValue placeholder="Select a project..." />
          </SelectTrigger>
          <SelectContent className="pr-twp">
            {projects?.map((project) => (
              <SelectItem key={project.path} value={project.path}>
                {project.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {projects === undefined && !listError && <Spinner />}
        {isDirty && (
          <span className="tw:text-muted-foreground tw:text-xs">
            Save or cancel your changes to switch projects.
          </span>
        )}
      </div>
      {selectedPath && (
        <div className="tw:text-muted-foreground tw:text-xs" title={selectedPath}>
          Editing {selectedPath}\ProjectUserAccess.xml
        </div>
      )}

      {activeProjectError && (
        <div className="tw:text-destructive">
          Could not open the active project automatically: {activeProjectError} Please select it
          below instead.
        </div>
      )}

      {listError && (
        <div className="tw:text-destructive">Could not find any projects: {listError}</div>
      )}
      {projects && projects.length === 0 && !listError && (
        <div className="tw:text-muted-foreground">
          No Paratext projects were found on this computer.
        </div>
      )}

      {isLoadingRoles && <Spinner />}
      {rolesError && <div className="tw:text-destructive">{rolesError}</div>}

      {isAdministrator && (
        <div className="tw:text-muted-foreground tw:text-sm">
          You are this project&rsquo;s Administrator. Changes you make below are not written to the
          project until you click Save.
        </div>
      )}

      {rolesData && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Books</TableHead>
              <TableHead>Permissions</TableHead>
              {isAdministrator && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {usersToShow.map((user) => {
              const isCurrentUser = user.userName === rolesData.currentUserName;
              const editable = isAdministrator && !user.removed;
              const removeBlockedReason = user.firstUser
                ? 'The project owner cannot be removed'
                : isCurrentUser
                  ? 'You cannot remove yourself - another Administrator must'
                  : undefined;
              return (
                <TableRow
                  key={user.userName}
                  className={user.removed ? 'tw:line-through tw:opacity-50' : ''}
                >
                  <TableCell>
                    {user.userName}
                    {user.firstUser && (
                      <Badge variant="secondary" className="tw:ml-2">
                        Project owner
                      </Badge>
                    )}
                    {user.unregisteredUser && (
                      <Badge variant="outline" className="tw:ml-2">
                        Unregistered
                      </Badge>
                    )}
                    {isCurrentUser && (
                      <Badge variant="outline" className="tw:ml-2">
                        You
                      </Badge>
                    )}
                    {user.isNew && (
                      <Badge variant="default" className="tw:ml-2">
                        New
                      </Badge>
                    )}
                    {user.removed && (
                      <Badge variant="destructive" className="tw:ml-2">
                        Will be removed
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {editable && !isCurrentUser ? (
                      <Select
                        value={user.role}
                        onValueChange={(role) => handleChangeRole(user.userName, role)}
                      >
                        <SelectTrigger className="pr-twp tw:w-40" aria-label="Role">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="pr-twp">
                          {rolesData.availableRoles.map((role) => (
                            <SelectItem key={role} value={role}>
                              {role}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      user.role
                    )}
                  </TableCell>
                  <TableCell>
                    <BookAccess
                      allBooks={user.allBooks}
                      books={user.books}
                      editable={editable}
                      availableBookIds={rolesData.allProjectBookIds}
                      onToggleAllBooks={(allBooks) => handleToggleAllBooks(user.userName, allBooks)}
                      onToggleBook={(bookId, granted) =>
                        handleToggleBook(user.userName, bookId, granted)
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Permissions
                      permissions={user.permissions}
                      editable={editable}
                      onToggle={(permissionType, granted) =>
                        handleTogglePermission(user.userName, permissionType, granted)
                      }
                    />
                  </TableCell>
                  {isAdministrator && (
                    <TableCell className="tw:text-right">
                      {user.removed ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => handleSetRemoved(user.userName, false)}
                        >
                          Undo
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="tw:text-destructive"
                          disabled={removeBlockedReason !== undefined}
                          title={removeBlockedReason}
                          onClick={() => handleSetRemoved(user.userName, true)}
                        >
                          Remove
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {isAdministrator && rolesData && draft && (
        <>
          <div className="tw:flex tw:flex-col tw:gap-1 tw:rounded-md tw:border tw:p-3">
            <div className="tw:text-sm tw:font-semibold">Adding users</div>
            <div className="tw:text-muted-foreground tw:text-sm">
              New users must be added to the project on the Paratext Registry, which also gives them
              access through Send/Receive. Once they are members there, they appear here after the
              next Send/Receive and you can set their books and permissions.
            </div>
            {rolesData.registryId ? (
              <Button
                type="button"
                variant="link"
                className="tw:h-auto tw:self-start tw:p-0"
                aria-label="Opens in browser"
                onClick={() => openRegistryMembers(rolesData.registryId ?? '')}
              >
                Manage members of {rolesData.projectId} on the Paratext Registry ↗
              </Button>
            ) : (
              <div className="tw:text-muted-foreground tw:text-xs">
                This project has no registration code in its Settings.xml, so it isn&rsquo;t
                registered on the Paratext Registry.
              </div>
            )}
          </div>

          <div className="tw:flex tw:items-center tw:gap-3 tw:border-t tw:pt-4">
            <Button type="button" disabled={!isDirty || isSaving} onClick={handleSave}>
              {isSaving ? 'Saving...' : 'Save'}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!isDirty || isSaving}
              onClick={handleCancel}
            >
              Cancel
            </Button>
            {isSaving && <Spinner />}
            {isDirty && !isSaving && (
              <span className="tw:text-muted-foreground tw:text-sm">You have unsaved changes.</span>
            )}
            {savedMessage && !isDirty && (
              <span className="tw:text-muted-foreground tw:text-sm">{savedMessage}</span>
            )}
          </div>
          {saveError && (
            <div className="tw:text-destructive">Could not save your changes: {saveError}</div>
          )}
        </>
      )}
    </div>
  );
};
