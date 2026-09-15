declare module 'project-user-roles' {
  /** One permission flag as recorded in ProjectUserAccess.xml */
  export type ProjectPermissionType =
    'TermsList' | 'Renderings' | 'Spellings' | 'Passages' | 'Progress';

  /** A single user's role, book access, and permissions for a project */
  export type ProjectUserInfo = {
    userName: string;
    role: string;
    firstUser: boolean;
    unregisteredUser: boolean;
    /** True if this user has access to every book, in which case `books` is not meaningful */
    allBooks: boolean;
    /** Book ids this user has access to (only meaningful when `allBooks` is false) */
    books: string[];
    /** Which of the fixed set of permission types are granted to this user */
    permissions: { [key in ProjectPermissionType]?: boolean };
  };

  /** One Paratext project found on disk, available to look up roles/permissions for */
  export type ProjectListEntry = {
    /** Project folder (short) name - also used as its id for these commands */
    id: string;
    /** Absolute path to the project's folder on disk */
    path: string;
  };

  /**
   * The complete desired state of a project's user list, as sent by the web view's Save button.
   * Users missing from `users` (compared to the project's current list) are removed; users not yet
   * in the project are added; everyone else is updated in place.
   */
  export type ProjectUserChangeSet = {
    users: ProjectUserDraft[];
  };

  /** One user's desired state within a {@link ProjectUserChangeSet} */
  export type ProjectUserDraft = {
    userName: string;
    /** One of {@link ProjectRolesPermissionsResult.availableRoles} */
    role: string;
    /**
     * Whether Paratext should treat this as an unregistered user (a name not in the Paratext
     * registry). Only used when adding a user; ignored for users already in the project.
     */
    unregisteredUser?: boolean;
    allBooks: boolean;
    books: string[];
    permissions: { [key in ProjectPermissionType]?: boolean };
  };

  /** Result of reading and parsing a project's ProjectUserAccess.xml */
  export type ProjectRolesPermissionsResult = {
    projectId: string;
    peerSharing: boolean;
    users: ProjectUserInfo[];
    /**
     * Display name of the Paratext user currently registered on this computer, if it could be
     * determined. This is who `currentUserIsAdministrator` is evaluated for.
     */
    currentUserName?: string;
    /**
     * Whether the current Paratext user is this project's Administrator, in which case the UI may
     * let them edit other users' permissions and book access.
     */
    currentUserIsAdministrator: boolean;
    /**
     * Every book id used anywhere in this project (the union of all users' `books` lists, in the
     * order each id first appears - typically canon order). There's no fixed canonical book list to
     * fall back on instead, since which books/peripheral-matter ids exist varies by project, so
     * this is empty if every user in the project has `allBooks: true`.
     */
    allProjectBookIds: string[];
    /**
     * Roles a user in this project may be given: the roles Paratext itself defines, plus any other
     * role text already present in this project's file.
     */
    availableRoles: string[];
    /**
     * The project's registration code on the Paratext Registry (from `<ParatextRegistryId>` in
     * Settings.xml), used to link to the project's Members page where users are added. Undefined
     * if the project is not registered.
     */
    registryId?: string;
  };
}

declare module 'papi-shared-types' {
  import type {
    ProjectListEntry,
    ProjectPermissionType,
    ProjectRolesPermissionsResult,
    ProjectUserChangeSet,
  } from 'project-user-roles';

  export interface CommandHandlers {
    /** Scans well-known Paratext project locations for projects found on this computer */
    'projectUserRoles.listProjects': () => Promise<ProjectListEntry[]>;
    /**
     * Reads and parses the given project's ProjectUserAccess.xml, alongside whether the current
     * Paratext user is this project's Administrator.
     *
     * @param projectPath Absolute path to the project's folder, from a {@link ProjectListEntry}
     */
    'projectUserRoles.getRolesPermissions': (
      projectPath: string,
    ) => Promise<ProjectRolesPermissionsResult>;
    /**
     * Grants or revokes one permission flag for one user in a project. Only succeeds if the current
     * Paratext user is this project's Administrator - this is re-checked here rather than trusted
     * from the caller, since it authorizes a write to disk.
     *
     * @param projectPath Absolute path to the project's folder, from a {@link ProjectListEntry}
     * @param userName The user to change, from a {@link ProjectUserInfo.userName}
     * @param permissionType Which permission flag to change
     * @param granted The new value for that permission flag
     * @returns The project's roles/permissions, freshly re-read after the change
     * @throws If the current user is not this project's Administrator, if `userName` doesn't match
     *   a user in the project, or if the file couldn't be written
     */
    'projectUserRoles.setUserPermission': (
      projectPath: string,
      userName: string,
      permissionType: ProjectPermissionType,
      granted: boolean,
    ) => Promise<ProjectRolesPermissionsResult>;
    /**
     * Sets whether a user has access to every book in the project (as opposed to only the books in
     * their explicit list). Only succeeds if the current Paratext user is this project's
     * Administrator - see `projectUserRoles.setUserPermission`.
     *
     * @param projectPath Absolute path to the project's folder, from a {@link ProjectListEntry}
     * @param userName The user to change, from a {@link ProjectUserInfo.userName}
     * @param allBooks The new value for whether this user has access to every book
     * @returns The project's roles/permissions, freshly re-read after the change
     */
    'projectUserRoles.setUserAllBooks': (
      projectPath: string,
      userName: string,
      allBooks: boolean,
    ) => Promise<ProjectRolesPermissionsResult>;
    /**
     * Grants or revokes one user's access to one book (meaningful only while that user's `allBooks`
     * is `false`). Only succeeds if the current Paratext user is this project's Administrator - see
     * `projectUserRoles.setUserPermission`.
     *
     * @param projectPath Absolute path to the project's folder, from a {@link ProjectListEntry}
     * @param userName The user to change, from a {@link ProjectUserInfo.userName}
     * @param bookId The book to change, from {@link ProjectRolesPermissionsResult.allProjectBookIds}
     * @param granted The new value for whether this user has access to this book
     * @returns The project's roles/permissions, freshly re-read after the change
     */
    'projectUserRoles.setUserBook': (
      projectPath: string,
      userName: string,
      bookId: string,
      granted: boolean,
    ) => Promise<ProjectRolesPermissionsResult>;
    /**
     * Applies a whole set of changes to a project's user list in one write of its
     * ProjectUserAccess.xml - updating, adding and removing users as needed to match `changes`.
     * This is what the web view's Save button calls. Only succeeds if the current Paratext user is
     * this project's Administrator (re-checked here, as it authorizes a write to disk), and refuses
     * changes that would remove the project owner, remove or demote the current user, or leave the
     * project with no Administrator. Nothing is written if any part of the change set is invalid.
     *
     * @param projectPath Absolute path to the project's folder, from a {@link ProjectListEntry}
     * @param changes The complete desired user list
     * @returns The project's roles/permissions, freshly re-read after the change
     */
    'projectUserRoles.applyChanges': (
      projectPath: string,
      changes: ProjectUserChangeSet,
    ) => Promise<ProjectRolesPermissionsResult>;
    /**
     * Opens the Project User Roles web view for a project. Registered as the handler for the
     * "Project User Roles..." item in a project web view's Project menu, in which case
     * Platform.Bible invokes it with the id of the web view whose menu was used (so the active
     * project can be inferred from it); if that doesn't resolve to a project (e.g. no web view id
     * was given), the user is prompted to pick one.
     *
     * @param webViewId Id of the web view whose Project menu triggered this command, if any
     * @returns Id of the opened web view, or `undefined` if no project was resolved/selected
     */
    'projectUserRoles.openForActiveProject': (webViewId?: string) => Promise<string | undefined>;
    /**
     * Resolves a Platform.Bible project id to the absolute path of its on-disk project folder, as
     * used by {@link ProjectListEntry} and `projectUserRoles.getRolesPermissions`.
     *
     * @param projectId Platform.Bible project id (e.g. from a web view's `projectId`)
     * @returns Absolute path to the project's folder, or `undefined` if it could not be resolved
     */
    'projectUserRoles.resolveProjectPath': (projectId: string) => Promise<string | undefined>;
  }
}
