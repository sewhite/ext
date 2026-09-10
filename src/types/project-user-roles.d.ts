declare module 'project-user-roles' {
  /** One permission flag as recorded in ProjectUserAccess.xml */
  export type ProjectPermissionType =
    | 'TermsList'
    | 'Renderings'
    | 'Spellings'
    | 'Passages'
    | 'Progress';

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

  /** Result of reading and parsing a project's ProjectUserAccess.xml */
  export type ProjectRolesPermissionsResult = {
    projectId: string;
    peerSharing: boolean;
    users: ProjectUserInfo[];
  };
}

declare module 'papi-shared-types' {
  import type {
    ProjectListEntry,
    ProjectRolesPermissionsResult,
  } from 'project-user-roles';

  export interface CommandHandlers {
    /** Scans well-known Paratext project locations for projects found on this computer */
    'projectUserRoles.listProjects': () => Promise<ProjectListEntry[]>;
    /**
     * Reads and parses the given project's ProjectUserAccess.xml
     *
     * @param projectPath Absolute path to the project's folder, from a {@link ProjectListEntry}
     */
    'projectUserRoles.getRolesPermissions': (
      projectPath: string,
    ) => Promise<ProjectRolesPermissionsResult>;
  }
}
