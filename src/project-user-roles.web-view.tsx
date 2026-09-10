import papi from '@papi/frontend';
import {
  Badge,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from 'platform-bible-react';
import type { ProjectListEntry, ProjectRolesPermissionsResult } from 'project-user-roles';
import { useEffect, useState } from 'react';

const PERMISSION_LABELS: Record<string, string> = {
  TermsList: 'Terms List',
  Renderings: 'Renderings',
  Spellings: 'Spellings',
  Passages: 'Passages',
  Progress: 'Progress',
};

function BookAccess({ allBooks, books }: { allBooks: boolean; books: string[] }) {
  if (allBooks) return <span>All books</span>;
  if (books.length === 0) return <span className="tw-text-muted-foreground">No books</span>;
  return (
    <span title={books.join(', ')}>
      {books.length} book{books.length === 1 ? '' : 's'}
    </span>
  );
}

function Permissions({ permissions }: { permissions: Record<string, boolean | undefined> }) {
  return (
    <div className="tw-flex tw-flex-wrap tw-gap-1">
      {Object.entries(PERMISSION_LABELS).map(([key, label]) => {
        const granted = permissions[key] === true;
        return (
          <Badge
            key={key}
            variant={granted ? 'default' : 'outline'}
            className={granted ? '' : 'tw-text-muted-foreground'}
          >
            {label}
          </Badge>
        );
      })}
    </div>
  );
}

globalThis.webViewComponent = function ProjectUserRoles() {
  const [projects, setProjects] = useState<ProjectListEntry[] | undefined>(undefined);
  const [selectedPath, setSelectedPath] = useState<string | undefined>(undefined);
  const [rolesData, setRolesData] = useState<ProjectRolesPermissionsResult | undefined>(
    undefined,
  );
  const [listError, setListError] = useState<string | undefined>(undefined);
  const [rolesError, setRolesError] = useState<string | undefined>(undefined);
  const [isLoadingRoles, setIsLoadingRoles] = useState(false);

  async function loadProjects() {
    setListError(undefined);
    setProjects(undefined);
    try {
      const found = await papi.commands.sendCommand('projectUserRoles.listProjects');
      setProjects(found);
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    loadProjects();
  }, []);

  useEffect(() => {
    if (!selectedPath) {
      setRolesData(undefined);
      return;
    }
    setRolesError(undefined);
    setRolesData(undefined);
    setIsLoadingRoles(true);
    papi.commands
      .sendCommand('projectUserRoles.getRolesPermissions', selectedPath)
      .then((result) => setRolesData(result))
      .catch((e) => setRolesError(e instanceof Error ? e.message : String(e)))
      .finally(() => setIsLoadingRoles(false));
  }, [selectedPath]);

  return (
    <div className="pr-twp tw-flex tw-flex-col tw-gap-4 tw-p-6">
      <div className="tw-text-2xl tw-font-semibold tw-tracking-tight">Project User Roles</div>

      <div className="tw-flex tw-items-center tw-gap-3">
        <Select value={selectedPath} onValueChange={setSelectedPath}>
          <SelectTrigger className="pr-twp tw-w-64">
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
      </div>

      {listError && (
        <div className="tw-text-destructive">Could not find any projects: {listError}</div>
      )}
      {projects && projects.length === 0 && !listError && (
        <div className="tw-text-muted-foreground">
          No Paratext projects were found on this computer.
        </div>
      )}

      {isLoadingRoles && <Spinner />}
      {rolesError && <div className="tw-text-destructive">{rolesError}</div>}

      {rolesData && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Books</TableHead>
              <TableHead>Permissions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rolesData.users.map((user) => (
              <TableRow key={user.userName}>
                <TableCell>
                  {user.userName}
                  {user.firstUser && (
                    <Badge variant="secondary" className="tw-ml-2">
                      Project owner
                    </Badge>
                  )}
                  {user.unregisteredUser && (
                    <Badge variant="outline" className="tw-ml-2">
                      Unregistered
                    </Badge>
                  )}
                </TableCell>
                <TableCell>{user.role}</TableCell>
                <TableCell>
                  <BookAccess allBooks={user.allBooks} books={user.books} />
                </TableCell>
                <TableCell>
                  <Permissions permissions={user.permissions} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
};
