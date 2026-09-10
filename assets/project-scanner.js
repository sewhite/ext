// Helper process for the project-user-roles extension.
//
// Runs as a plain, unrestricted Node process (via the `createProcess` elevated privilege's
// `fork`), because extensions themselves cannot import `fs`/`path` - see
// webpack.config.base.ts's `externals` comment. This script does the actual disk I/O:
// finding Paratext project folders and reading/parsing their ProjectUserAccess.xml.
//
// Usage: node project-scanner.js list
//        node project-scanner.js get <projectPath>
//
// Always prints exactly one JSON value to stdout and exits. On success that value is the
// result data; on failure it is `{ "error": "<message>" }`.

const fs = require('fs');
const path = require('path');
const os = require('os');

/** Well-known places Paratext project folders are known to live on Windows. */
function getCandidateRoots() {
  const roots = [];
  const drive = 'C:\\';
  // Classic per-machine install convention used by Paratext 7 through 9 (and still read by
  // Platform.Bible): a top-level "My Paratext <version> Projects" folder.
  for (const version of [10, 9, 8, 7]) {
    roots.push(path.join(drive, `My Paratext ${version} Projects`));
  }
  // Platform.Bible (Paratext 10 Studio)'s own local project store.
  const studioProjects = path.join(os.homedir(), '.paratext-10-studio', 'projects');
  roots.push(studioProjects);
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
 * A project's `unique.id` file content (falling back to its ProjectUserAccess.xml content) if
 * we can read it, used to recognize the same project appearing at more than one on-disk
 * location (e.g. Platform.Bible keeps its own copy alongside a classic Paratext 9 install).
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
  };
}

function main() {
  const [action, arg] = process.argv.slice(2);
  try {
    let result;
    if (action === 'list') {
      result = listProjects();
    } else if (action === 'get') {
      if (!arg) throw new Error('Missing projectPath argument for "get"');
      result = getRolesPermissions(arg);
    } else {
      throw new Error(`Unknown action: ${action}`);
    }
    process.stdout.write(JSON.stringify(result));
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: e && e.message ? e.message : String(e) }));
  }
}

main();
