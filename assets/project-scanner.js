// Helper process for the project-user-roles extension.
//
// Runs as a plain, unrestricted Node process (via the `createProcess` elevated privilege's
// `fork`), because extensions themselves cannot import `fs`/`path` - see
// webpack.config.base.ts's `externals` comment. This script does the actual disk I/O:
// finding Paratext project folders and reading/parsing their ProjectUserAccess.xml.
//
// Usage: node project-scanner.js list
//        node project-scanner.js get <projectPath>
//        node project-scanner.js whoami
//        node project-scanner.js set <projectPath> <userName> <permissionType> <true|false>
//        node project-scanner.js setAllBooks <projectPath> <userName> <true|false>
//        node project-scanner.js setBook <projectPath> <userName> <bookId> <true|false>
//        node project-scanner.js apply <projectPath>   (reads a JSON change set from stdin)
//
// Always prints exactly one JSON value to stdout and exits. On success that value is the
// result data; on failure it is `{ "error": "<message>" }`.

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Well-known places Paratext project folders are known to live on Windows, in order of
 * preference. When the same project exists in more than one place (`listProjects` recognizes this
 * by `unique.id`), the copy from the earliest root here is the one shown and edited.
 *
 * Paratext 10 Studio's own store comes first: it is the copy Paratext 10 actually reads, so that
 * is where an Administrator's changes must land. The classic "My Paratext 9 Projects" folder is
 * Paratext 9's copy of the same project (Paratext 10 Studio keeps its own under
 * `projects/Paratext 9 Projects/<project>`), so it is only used for projects Paratext 10 Studio
 * does not have.
 */
function getCandidateRoots() {
  const roots = [];
  // Platform.Bible (Paratext 10 Studio)'s own local project store.
  roots.push(path.join(os.homedir(), '.paratext-10-studio', 'projects'));
  const drive = 'C:\\';
  // Classic per-machine install convention used by Paratext 7 through 9: a top-level
  // "My Paratext <version> Projects" folder.
  for (const version of [10, 9, 8, 7]) {
    roots.push(path.join(drive, `My Paratext ${version} Projects`));
  }
  return roots.filter((root) => {
    try {
      return fs.statSync(root).isDirectory();
    } catch {
      return false;
    }
  });
}

function isProjectFolder(dirPath) {
  return fs.existsSync(path.join(dirPath, 'ProjectUserAccess.xml'));
}

/** Recursively find project folders under `dirPath`, without descending into ones we find. */
function findProjectFolders(dirPath, maxDepth, found, seen) {
  if (maxDepth < 0) return;
  const resolved = path.resolve(dirPath);
  if (seen.has(resolved)) return;
  seen.add(resolved);

  if (isProjectFolder(resolved)) {
    found.push(resolved);
    return;
  }

  let entries;
  try {
    entries = fs.readdirSync(resolved, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    findProjectFolders(path.join(resolved, entry.name), maxDepth - 1, found, seen);
  }
}

/**
 * A project's `unique.id` file content (falling back to its ProjectUserAccess.xml content) if we
 * can read it, used to recognize the same project appearing at more than one on-disk location (e.g.
 * Platform.Bible keeps its own copy alongside a classic Paratext 9 install).
 */
function getProjectIdentity(projectPath) {
  for (const fileName of ['unique.id', 'ProjectUserAccess.xml']) {
    try {
      return fs.readFileSync(path.join(projectPath, fileName), 'utf8');
    } catch {
      // try the next file
    }
  }
  return undefined;
}

function listProjects() {
  const found = [];
  const seen = new Set();
  for (const root of getCandidateRoots()) {
    findProjectFolders(root, 3, found, seen);
  }

  const dedupedByIdentity = new Set();
  const projects = [];
  for (const projectPath of found) {
    const identity = getProjectIdentity(projectPath) ?? projectPath;
    if (dedupedByIdentity.has(identity)) continue;
    dedupedByIdentity.add(identity);
    projects.push({ id: path.basename(projectPath), path: projectPath });
  }
  return projects;
}

// --- Minimal, purpose-built XML parsing for ProjectUserAccess.xml ---
// Not a general XML parser - just enough for this file's simple, non-nested structure.

/** Roles Paratext itself knows about, as spelled in ProjectUserAccess.xml's <Role> element. */
const VALID_ROLES = ['Administrator', 'Translator', 'Consultant', 'Observer', 'TypeSetter'];

const ENTITY_MAP = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function xmlUnescape(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity) => {
    if (entity[0] === '#') {
      const codePoint =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return String.fromCodePoint(codePoint);
    }
    return ENTITY_MAP[entity] ?? whole;
  });
}

function getAttr(tag, name) {
  const match = tag.match(new RegExp(`${name}="([^"]*)"`));
  return match ? xmlUnescape(match[1]) : undefined;
}

function getElementText(xml, tagName) {
  const match = xml.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`));
  return match ? xmlUnescape(match[1]).trim() : undefined;
}

function parseUser(userXml, openTag) {
  const permissions = {};
  const permissionsBlockMatch = userXml.match(/<Permissions>([\s\S]*?)<\/Permissions>/);
  if (permissionsBlockMatch) {
    const permissionTagRe = /<Permission\s+Type="([^"]*)"\s+Granted="([^"]*)"\s*\/>/g;
    let permMatch;
    while ((permMatch = permissionTagRe.exec(permissionsBlockMatch[1]))) {
      permissions[permMatch[1]] = permMatch[2] === 'true';
    }
  }

  const books = [];
  const booksBlockMatch = userXml.match(/<Books>([\s\S]*?)<\/Books>/);
  if (booksBlockMatch) {
    const bookTagRe = /<Book\s+Id="([^"]*)"\s*\/>/g;
    let bookMatch;
    while ((bookMatch = bookTagRe.exec(booksBlockMatch[1]))) {
      books.push(bookMatch[1]);
    }
  }

  return {
    userName: getAttr(openTag, 'UserName') ?? '',
    firstUser: getAttr(openTag, 'FirstUser') === 'true',
    unregisteredUser: getAttr(openTag, 'UnregisteredUser') === 'true',
    role: getElementText(userXml, 'Role') ?? '',
    allBooks: getElementText(userXml, 'AllBooks') === 'true',
    books,
    permissions,
  };
}

/**
 * The set of book ids this project actually uses, as the union of every user's explicit `books`
 * list (in the order each id first appears - typically canon order, since that's how Paratext
 * itself writes each user's list). There's no fixed canonical book list we can rely on instead:
 * exactly which books/peripheral-matter ids exist varies by project. A project where every user has
 * `AllBooks` set (so nobody has an explicit list to draw from) will get an empty result here.
 */
function getAllProjectBookIds(users) {
  const seen = new Set();
  const bookIds = [];
  for (const user of users) {
    for (const bookId of user.books) {
      if (seen.has(bookId)) continue;
      seen.add(bookId);
      bookIds.push(bookId);
    }
  }
  return bookIds;
}

/** Roles a user may be given: Paratext's own, plus any other role text already in this file. */
function getAvailableRoles(users) {
  const roles = [...VALID_ROLES];
  for (const user of users) {
    if (user.role && !roles.includes(user.role)) roles.push(user.role);
  }
  return roles;
}

/**
 * The project's registration code on the Paratext Registry (https://registry.paratext.org), from
 * `<ParatextRegistryId>` in the project's Settings.xml. Undefined for an unregistered project or if
 * the file can't be read.
 */
function getRegistryId(projectPath) {
  try {
    const xml = fs.readFileSync(path.join(projectPath, 'Settings.xml'), 'utf8').replace(/^\uFEFF/, '');
    const id = getElementText(xml, 'ParatextRegistryId');
    return id || undefined;
  } catch {
    return undefined;
  }
}

function getRolesPermissions(projectPath) {
  const filePath = path.join(projectPath, 'ProjectUserAccess.xml');
  const xml = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');

  const rootOpenTagMatch = xml.match(/<ProjectUserAccess\b[^>]*>/);
  const peerSharing = rootOpenTagMatch
    ? getAttr(rootOpenTagMatch[0], 'PeerSharing') === 'true'
    : false;

  const users = [];
  const userRe = /<User\s+([^>]*)>([\s\S]*?)<\/User>/g;
  let userMatch;
  while ((userMatch = userRe.exec(xml))) {
    const [, attrs, body] = userMatch;
    users.push(parseUser(body, `<User ${attrs}>`));
  }

  return {
    projectId: path.basename(projectPath),
    peerSharing,
    users,
    allProjectBookIds: getAllProjectBookIds(users),
    availableRoles: getAvailableRoles(users),
    registryId: getRegistryId(projectPath),
  };
}

// --- Current user identity ---

/**
 * Finds the display name of the currently registered Paratext user on this computer, by reading the
 * newest-version Paratext installation's RegistrationInfo.xml under `%LOCALAPPDATA%` - the same
 * registration Paratext writes into a project's ProjectUserAccess.xml `UserName` attribute when
 * that user makes changes. There is no papi API for this (it's not exposed to extensions), so we
 * read it directly here alongside the rest of this script's other unrestricted-Node-process disk
 * access. Returns undefined if no registration could be found.
 *
 * Note: a "Switch User" leaves other registrations behind as `RegistrationInfo.<name>` in the same
 * folder - we intentionally only ever read the exact filename `RegistrationInfo.xml`, which is the
 * currently active one.
 */
function getCurrentUserName() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  let entries;
  try {
    entries = fs.readdirSync(localAppData, { withFileTypes: true });
  } catch {
    return undefined;
  }

  const versionedDirNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name.match(/^Paratext(\d+)$/))
    .filter((match) => match !== null)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map((match) => match[0]);

  for (const dirName of versionedDirNames) {
    const registrationPath = path.join(localAppData, dirName, 'RegistrationInfo.xml');
    try {
      const xml = fs.readFileSync(registrationPath, 'utf8').replace(/^\uFEFF/, '');
      const registeredName = getElementText(xml, 'Name');
      if (registeredName) return registeredName;
    } catch {
      // This version has no registration (or we can't read it) - try the next-newest version.
    }
  }
  return undefined;
}

// --- Editing a user's granted permissions/books ---

const VALID_PERMISSION_TYPES = ['TermsList', 'Renderings', 'Spellings', 'Passages', 'Progress'];

/** Sets one `<Permission Type="..." Granted="..." />` flag within a single `<User>` element's body. */
function setPermissionInUserBody(body, permissionType, granted) {
  const grantedAttr = granted ? 'true' : 'false';
  const newTag = `<Permission Type="${permissionType}" Granted="${grantedAttr}" />`;

  const permissionTagRe = new RegExp(
    `<Permission\\s+Type="${permissionType}"\\s+Granted="[^"]*"\\s*/>`,
  );
  if (permissionTagRe.test(body)) return body.replace(permissionTagRe, newTag);

  // This user's Permissions block doesn't have an entry for this type yet - add one.
  if (/<Permissions\s*\/>/.test(body))
    return body.replace(/<Permissions\s*\/>/, `<Permissions>${newTag}</Permissions>`);
  if (/<\/Permissions>/.test(body))
    return body.replace(/<\/Permissions>/, `${newTag}</Permissions>`);

  throw new Error('This project user has no <Permissions> element to add a permission to');
}

/**
 * Sets the `<AllBooks>true|false</AllBooks>` element's text within a single `<User>` element's
 * body.
 */
function setAllBooksInUserBody(body, allBooks) {
  const allBooksRe = /<AllBooks>[^<]*<\/AllBooks>/;
  if (!allBooksRe.test(body))
    throw new Error('This project user has no <AllBooks> element to update');
  return body.replace(allBooksRe, `<AllBooks>${allBooks ? 'true' : 'false'}</AllBooks>`);
}

/**
 * Adds or removes one `<Book Id="..." />` entry within a single `<User>` element's `<Books>` list
 * (there's no "Granted" attribute to flip here, like there is for `<Permission>` - a book is simply
 * present or absent from the list).
 */
function setBookInUserBody(body, bookId, granted) {
  const bookTagRe = new RegExp(`\\s*<Book\\s+Id="${bookId}"\\s*/>`);
  if (!granted) return body.replace(bookTagRe, ''); // fine to no-op if it wasn't there
  if (bookTagRe.test(body)) return body; // already granted

  const newTag = `<Book Id="${bookId}" />`;
  if (/<Books\s*\/>/.test(body)) return body.replace(/<Books\s*\/>/, `<Books>${newTag}</Books>`);
  if (/<\/Books>/.test(body)) return body.replace(/<\/Books>/, `${newTag}</Books>`);

  throw new Error('This project user has no <Books> element to add a book to');
}

/**
 * Finds one user's `<User>...</User>` element in a project's ProjectUserAccess.xml, replaces its
 * body with `transformBody(body)`, and writes the result back - leaving everything else in the file
 * (including unrelated whitespace/formatting, and other users entirely) exactly as it was. Returns
 * the project's roles/permissions freshly re-read after the write, as a round-trip sanity check
 * that the edit produced a file we can still parse.
 */
function updateUserBody(projectPath, userName, transformBody) {
  const filePath = path.join(projectPath, 'ProjectUserAccess.xml');
  const raw = fs.readFileSync(filePath, 'utf8');
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
  const xml = bom ? raw.slice(1) : raw;

  let found = false;
  const userRe = /<User\s+([^>]*)>([\s\S]*?)<\/User>/g;
  const updatedXml = xml.replace(userRe, (whole, attrs, body) => {
    if (found || getAttr(`<User ${attrs}>`, 'UserName') !== userName) return whole;
    found = true;
    return `<User ${attrs}>${transformBody(body)}</User>`;
  });

  if (!found) throw new Error(`User "${userName}" was not found in this project`);

  fs.writeFileSync(filePath, bom + updatedXml, 'utf8');
  return getRolesPermissions(projectPath);
}

function setUserPermission(projectPath, userName, permissionType, grantedArg) {
  if (!VALID_PERMISSION_TYPES.includes(permissionType))
    throw new Error(`Unknown permission type: ${permissionType}`);
  const granted = grantedArg === 'true';
  return updateUserBody(projectPath, userName, (body) =>
    setPermissionInUserBody(body, permissionType, granted),
  );
}

function setUserAllBooks(projectPath, userName, allBooksArg) {
  const allBooks = allBooksArg === 'true';
  return updateUserBody(projectPath, userName, (body) => setAllBooksInUserBody(body, allBooks));
}

function setUserBook(projectPath, userName, bookId, grantedArg) {
  if (!isValidBookId(bookId)) throw new Error(`Invalid book id: ${bookId}`);
  const granted = grantedArg === 'true';
  return updateUserBody(projectPath, userName, (body) => setBookInUserBody(body, bookId, granted));
}

// --- Applying a whole set of changes at once (the web view's Save button) ---
//
// The web view lets an Administrator make any number of edits - toggling permissions/books,
// changing roles, adding users, removing users - as a local draft, then Save sends the complete
// desired user list here. We rewrite ProjectUserAccess.xml exactly once, so a half-finished set of
// edits can never be left on disk if something fails part-way through, and Cancel simply throws
// the draft away without ever calling us.

/** Escapes text for use inside an XML attribute value or element body. */
function xmlEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isValidBookId(bookId) {
  // Book ids are always short alphanumeric codes (e.g. "GEN", "1SA", "XXA") - reject anything else
  // rather than build it into a RegExp or write it into the file.
  return /^[A-Za-z0-9]{2,4}$/.test(bookId);
}

/**
 * Works out the indentation this file uses, from the whitespace before an existing element, so the
 * elements we write match the surrounding formatting. Falls back to `fallback` if there is no such
 * element (or it isn't at the start of its own line).
 */
function indentBefore(xml, elementRe, fallback) {
  const match = xml.match(new RegExp(`(^|\\n)([ \\t]*)${elementRe.source}`));
  return match ? match[2] : fallback;
}

/** Builds a `<Books>...</Books>` block (or a self-closing `<Books />` for an empty list). */
function buildBooksXml(books, booksIndent, bookIndent, newline) {
  if (books.length === 0) return '<Books />';
  const entries = books.map((bookId) => `${bookIndent}<Book Id="${bookId}" />`).join(newline);
  return `<Books>${newline}${entries}${newline}${booksIndent}</Books>`;
}

/** Builds a `<Permissions>...</Permissions>` block with an entry for every permission type. */
function buildPermissionsXml(permissions, permissionsIndent, permissionIndent, newline) {
  const entries = VALID_PERMISSION_TYPES.map(
    (type) =>
      `${permissionIndent}<Permission Type="${type}" Granted="${permissions[type] === true ? 'true' : 'false'}" />`,
  ).join(newline);
  return `<Permissions>${newline}${entries}${newline}${permissionsIndent}</Permissions>`;
}

/** The line ending this file uses, so lines we add match the rest of it. */
function detectNewline(xml) {
  return xml.includes('\r\n') ? '\r\n' : '\n';
}

/** Rewrites one existing `<User>` element's body to match the desired `user` state. */
function applyUserToBody(body, user, newline) {
  let updated = body;

  // Role (add the element if the file somehow lacks it)
  if (/<Role>[^<]*<\/Role>/.test(updated)) {
    updated = updated.replace(/<Role>[^<]*<\/Role>/, `<Role>${xmlEscape(user.role)}</Role>`);
  } else {
    updated = `<Role>${xmlEscape(user.role)}</Role>${updated}`;
  }

  updated = setAllBooksInUserBody(updated, user.allBooks);

  // Books: rebuild the whole list rather than diffing entries, so the result is exactly what the
  // Administrator saw in the draft (in the order given, which the UI keeps in project order).
  const booksIndent = indentBefore(updated, /<Books\b/, '    ');
  const bookIndent = indentBefore(updated, /<Book\s/, `${booksIndent}  `);
  const booksXml = buildBooksXml(user.books, booksIndent, bookIndent, newline);
  if (/<Books\s*\/>/.test(updated)) updated = updated.replace(/<Books\s*\/>/, booksXml);
  else if (/<Books>[\s\S]*?<\/Books>/.test(updated))
    updated = updated.replace(/<Books>[\s\S]*?<\/Books>/, booksXml);
  else throw new Error(`User "${user.userName}" has no <Books> element to update`);

  // Permissions: likewise rebuilt as a whole, in Paratext's own order, so a user whose block was
  // missing some types (or was an empty `<Permissions />`) ends up with a complete, tidy list.
  const permissionsIndent = indentBefore(updated, /<Permissions\b/, '    ');
  const permissionIndent = indentBefore(updated, /<Permission\s/, `${permissionsIndent}  `);
  const permissionsXml = buildPermissionsXml(
    user.permissions,
    permissionsIndent,
    permissionIndent,
    newline,
  );
  if (/<Permissions\s*\/>/.test(updated))
    updated = updated.replace(/<Permissions\s*\/>/, permissionsXml);
  else if (/<Permissions>[\s\S]*?<\/Permissions>/.test(updated))
    updated = updated.replace(/<Permissions>[\s\S]*?<\/Permissions>/, permissionsXml);
  else updated = `${updated}${permissionsXml}`;

  return updated;
}

/** Builds a complete `<User>` element for a user who isn't in the file yet. */
function buildNewUserXml(user, userIndent, newline) {
  const inner = `${userIndent}  `;
  return [
    `${userIndent}<User UserName="${xmlEscape(user.userName)}" FirstUser="false" UnregisteredUser="${user.unregisteredUser ? 'true' : 'false'}">`,
    `${inner}<Role>${xmlEscape(user.role)}</Role>`,
    `${inner}<AllBooks>${user.allBooks ? 'true' : 'false'}</AllBooks>`,
    `${inner}${buildBooksXml(user.books, inner, `${inner}  `, newline)}`,
    `${inner}${buildPermissionsXml(user.permissions, inner, `${inner}  `, newline)}`,
    `${userIndent}</User>`,
  ].join(newline);
}

/**
 * Checks a change set before anything is written, so every problem is reported without touching
 * the file. `existingUsers` is the project's current user list; `changes.users` is the complete
 * desired list (users missing from it are removed); `changes.currentUserName` is who is doing this,
 * so we can refuse edits that would lock them out.
 */
function validateChanges(changes, existingUsers) {
  if (!changes || !Array.isArray(changes.users))
    throw new Error('Change set must be an object with a "users" array');

  const knownRoles = new Set(getAvailableRoles(existingUsers));
  const seenNames = new Set();
  for (const user of changes.users) {
    const name = typeof user.userName === 'string' ? user.userName.trim() : '';
    if (!name) throw new Error('Every user needs a non-empty name');
    if (seenNames.has(name)) throw new Error(`User "${name}" appears more than once`);
    seenNames.add(name);
    if (!knownRoles.has(user.role))
      throw new Error(`Unknown role "${user.role}" for user "${name}"`);
    if (!Array.isArray(user.books)) throw new Error(`User "${name}" needs a "books" array`);
    for (const bookId of user.books) {
      if (!isValidBookId(bookId)) throw new Error(`Invalid book id "${bookId}" for user "${name}"`);
    }
    if (!user.permissions || typeof user.permissions !== 'object')
      throw new Error(`User "${name}" needs a "permissions" object`);
  }

  const owner = existingUsers.find((user) => user.firstUser);
  if (owner && !seenNames.has(owner.userName))
    throw new Error(`"${owner.userName}" is the project owner and cannot be removed`);

  if (!changes.users.some((user) => user.role === 'Administrator'))
    throw new Error('The project must keep at least one Administrator');

  if (changes.currentUserName) {
    const me = changes.users.find((user) => user.userName === changes.currentUserName);
    if (!me)
      throw new Error('You cannot remove yourself from the project (another Administrator must)');
    if (me.role !== 'Administrator')
      throw new Error(
        'You cannot change your own role away from Administrator (another Administrator must)',
      );
  }
}

/**
 * Replaces the project's whole user list with `changes.users` in a single write: existing users are
 * updated in place (their surrounding formatting untouched), users no longer in the list are
 * removed, and new users are appended before `</ProjectUserAccess>`. Returns the freshly re-read
 * roles/permissions as a round-trip check.
 */
function applyChanges(projectPath, changes) {
  const filePath = path.join(projectPath, 'ProjectUserAccess.xml');
  const raw = fs.readFileSync(filePath, 'utf8');
  const bom = raw.startsWith('﻿') ? '﻿' : '';
  const xml = bom ? raw.slice(1) : raw;

  const existing = getRolesPermissions(projectPath);
  validateChanges(changes, existing.users);

  const desiredByName = new Map(
    changes.users.map((user) => [
      user.userName.trim(),
      { ...user, userName: user.userName.trim() },
    ]),
  );
  const existingNames = new Set(existing.users.map((user) => user.userName));
  const newline = detectNewline(xml);

  // Update or remove every user already in the file. Removing also eats the line break and
  // indentation before the element, so no blank line is left behind.
  const userRe = /(\r?\n[ \t]*)?<User\s+([^>]*)>([\s\S]*?)<\/User>/g;
  let updatedXml = xml.replace(userRe, (whole, leadingWhitespace, attrs, body) => {
    const name = getAttr(`<User ${attrs}>`, 'UserName');
    const desired = desiredByName.get(name);
    if (!desired) return '';
    return `${leadingWhitespace ?? ''}<User ${attrs}>${applyUserToBody(body, desired, newline)}</User>`;
  });

  // Append users who are new to the file.
  const newUsers = changes.users.filter((user) => !existingNames.has(user.userName.trim()));
  if (newUsers.length > 0) {
    const closeRootRe = /(\r?\n)?([ \t]*)<\/ProjectUserAccess>/;
    if (!closeRootRe.test(updatedXml))
      throw new Error('Could not find </ProjectUserAccess> to add users before');
    const userIndent = indentBefore(xml, /<User\s/, '  ');
    const newUsersXml = newUsers
      .map((user) => buildNewUserXml(desiredByName.get(user.userName.trim()), userIndent, newline))
      .join(newline);
    updatedXml = updatedXml.replace(
      closeRootRe,
      (whole, nl, indent) => `${nl ?? ''}${newUsersXml}${newline}${indent}</ProjectUserAccess>`,
    );
  }

  fs.writeFileSync(filePath, bom + updatedXml, 'utf8');
  return getRolesPermissions(projectPath);
}

/**
 * Receives the JSON change set the extension sends us. The extension sends it both over the
 * fork's IPC channel (`child.send`) and on stdin; we take whichever arrives first. Two routes
 * because a payload can be too big for the command line, and stdin pipes on Windows have a habit
 * of misbehaving with synchronous reads - so stdin is read asynchronously here, IPC is preferred,
 * and we give up with a clear error rather than hang if neither delivers.
 */
function receivePayloadJson(timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(new Error(`Change set was not valid JSON: ${e && e.message ? e.message : e}`));
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Timed out waiting to receive the change set from the extension'));
    }, timeoutMs);

    if (typeof process.send === 'function') {
      process.on('message', (message) => {
        finish(typeof message === 'string' ? message : JSON.stringify(message));
      });
    }

    let buffered = '';
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        buffered += chunk;
      });
      process.stdin.on('end', () => {
        if (buffered.trim()) finish(buffered);
      });
      process.stdin.on('error', () => {
        // Ignore - IPC may still deliver, and the timeout covers the case where nothing does.
      });
    } catch {
      // No usable stdin - rely on IPC / the timeout.
    }
  });
}

/** Writes our single JSON result and exits (explicitly, since an IPC listener would keep us alive). */
function finishWith(result) {
  process.stdout.write(JSON.stringify(result), () => process.exit(0));
}

async function main() {
  const [action, ...rest] = process.argv.slice(2);
  try {
    let result;
    if (action === 'list') {
      result = listProjects();
    } else if (action === 'get') {
      const [projectPath] = rest;
      if (!projectPath) throw new Error('Missing projectPath argument for "get"');
      result = getRolesPermissions(projectPath);
    } else if (action === 'whoami') {
      result = { name: getCurrentUserName() };
    } else if (action === 'set') {
      const [projectPath, userName, permissionType, granted] = rest;
      if (!projectPath || !userName || !permissionType || granted === undefined)
        throw new Error('Usage: set <projectPath> <userName> <permissionType> <true|false>');
      result = setUserPermission(projectPath, userName, permissionType, granted);
    } else if (action === 'setAllBooks') {
      const [projectPath, userName, allBooks] = rest;
      if (!projectPath || !userName || allBooks === undefined)
        throw new Error('Usage: setAllBooks <projectPath> <userName> <true|false>');
      result = setUserAllBooks(projectPath, userName, allBooks);
    } else if (action === 'setBook') {
      const [projectPath, userName, bookId, granted] = rest;
      if (!projectPath || !userName || !bookId || granted === undefined)
        throw new Error('Usage: setBook <projectPath> <userName> <bookId> <true|false>');
      result = setUserBook(projectPath, userName, bookId, granted);
    } else if (action === 'apply') {
      const [projectPath] = rest;
      if (!projectPath) throw new Error('Usage: apply <projectPath>  (change set JSON on stdin)');
      result = applyChanges(projectPath, await receivePayloadJson(20000));
    } else if (action === 'roles') {
      result = VALID_ROLES;
    } else {
      throw new Error(`Unknown action: ${action}`);
    }
    finishWith(result);
  } catch (e) {
    finishWith({ error: e && e.message ? e.message : String(e) });
  }
}

main();
