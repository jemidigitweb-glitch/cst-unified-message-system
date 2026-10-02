import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Standing guard on the case import's isolation from the running application.
 *
 * THE RULE THIS DEFENDS. MySQL `message_app` allows 100 QUERIES and 50
 * CONNECTIONS PER HOUR, shared across every consumer. One CST agent working a
 * shift would exhaust the hour's budget in minutes if a page load could reach it,
 * and the failure mode is not a slow panel — it is every other consumer of that
 * account, including the message sync, locked out.
 *
 * So MySQL is reachable from exactly one place: a manual, standalone script. No
 * route, repository, resolver, component or page may import a MySQL driver or any
 * module that does, directly or transitively.
 *
 * `customer-history-repository.ts` already promises this for the Repeat-Customer
 * Warning in its header. This guard is what makes the promise checkable, for that
 * feature and this one.
 */

const ROOT = join(__dirname, "..", "..");
const APP_DIR = join(ROOT, "app");
const LIB_DIR = join(ROOT, "lib");
const COMPONENTS_DIR = join(ROOT, "components");
const SCRIPTS_DIR = join(ROOT, "scripts");

const IMPORTER = join(SCRIPTS_DIR, "import-marketplace-cases.mjs");
const SOURCE_READER = join(LIB_DIR, "db", "message-app-case-source.ts");
const WRITER = join(LIB_DIR, "sync", "marketplace-case-writer.ts");
const EXTRACT = join(LIB_DIR, "domain", "marketplace-case-extract.ts");
const DOMAIN = join(LIB_DIR, "domain", "marketplace-case.ts");
const LOOKUP = join(LIB_DIR, "repositories", "order-line-lookup-repository.ts");

/** Every source file under a directory. */
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    // `.mjs` matters: the importer is one, and omitting it made the
    // "only the importer opens MySQL" test pass against an empty list.
    else if ([".ts", ".tsx", ".mts", ".mjs", ".js"].includes(extname(path))) out.push(path);
  }
  return out;
}

/** Strips comments, so prose explaining why MySQL is absent is not read as MySQL. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/\/\/[^\n]*/g, " ");
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** The local modules a file imports, resolved to repository paths where possible. */
function localImports(source: string): string[] {
  return [...code(source).matchAll(/from\s+["'](@\/[^"']+)["']/g)].map((m) => m[1]!);
}

/**
 * Every module reachable from a set of entry points by `@/` imports, so a
 * transitive MySQL dependency is caught rather than only a direct one.
 */
function reachableModules(entries: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const path = queue.pop()!;
    if (seen.has(path)) continue;
    seen.add(path);
    let source: string;
    try {
      source = read(path);
    } catch {
      continue;
    }
    for (const spec of localImports(source)) {
      const base = join(ROOT, spec.slice(2));
      for (const candidate of [
        `${base}.ts`,
        `${base}.tsx`,
        join(base, "index.ts"),
        base,
      ]) {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          queue.push(candidate);
          break;
        }
      }
    }
  }
  return seen;
}

const MYSQL_MARKERS = [/\bmysql2\b/, /\bcreateConnection\b/, /\bcreatePool\b/, /\bmariadb\b/];

const appFiles = walk(APP_DIR);
const componentFiles = walk(COMPONENTS_DIR);

// ===========================================================================
describe("16 — no MySQL dependency in the CST runtime", () => {
  it("no route, page or component names a MySQL driver", () => {
    const offenders: string[] = [];
    for (const file of [...appFiles, ...componentFiles]) {
      const source = code(read(file));
      for (const marker of MYSQL_MARKERS) {
        if (marker.test(source)) offenders.push(`${file} :: ${String(marker)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * TRANSITIVELY, which is the half a name check misses. A route that imports a
   * repository that imports the MySQL reader would pass a direct scan and still
   * open a connection on a page load.
   */
  it("no module reachable from app/ imports the MySQL case reader", () => {
    const reachable = reachableModules(appFiles);
    const offenders = [...reachable].filter(
      (path) =>
        path.endsWith(join("db", "message-app-case-source.ts")) ||
        path.endsWith(join("db", "message-app-source.ts")) ||
        path.endsWith(join("db", "order-source.ts")),
    );
    expect(offenders).toEqual([]);
  });

  it("no module reachable from app/ names a MySQL driver", () => {
    const offenders: string[] = [];
    for (const path of reachableModules(appFiles)) {
      let source: string;
      try {
        source = code(read(path));
      } catch {
        continue;
      }
      for (const marker of MYSQL_MARKERS) {
        if (marker.test(source)) offenders.push(`${path} :: ${String(marker)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * MySQL reaches exactly one entry point. `order-source.ts` is listed because it
   * is where `assertOrderSourceReadOnly` lives and the importer must call it; it
   * contains no driver of its own, only the injected interface.
   */
  it("the standalone importer is the only place a MySQL connection is opened", () => {
    const openers: string[] = [];
    for (const file of [...walk(LIB_DIR), ...walk(SCRIPTS_DIR)]) {
      const source = code(read(file));
      if (/\bmysql2\b/.test(source) || /mysql\.createConnection/.test(source)) {
        openers.push(file.replace(ROOT, "").replace(/\\/g, "/"));
      }
    }
    // Every opener must be a script, never a library module.
    for (const opener of openers) {
      expect(opener, `${opener} opens MySQL outside scripts/`).toMatch(/^\/scripts\//);
    }
    expect(openers).toContain("/scripts/import-marketplace-cases.mjs");
  });
});

// ===========================================================================
describe("the importer respects the source connection discipline", () => {
  const importer = code(read(IMPORTER));

  it("opens exactly one connection and creates no pool", () => {
    expect(importer.match(/mysql\.createConnection/g)).toHaveLength(1);
    expect(importer).not.toMatch(/createPool/);
    expect(importer).not.toMatch(/connectionLimit/);
  });

  it("closes the connection in a finally block", () => {
    expect(importer).toMatch(/finally\s*\{[\s\S]{0,400}connection\.end\(\)/);
  });

  it("retries nothing automatically", () => {
    // No retry loop, no backoff, no second attempt around the connect call.
    expect(importer).not.toMatch(/\bretry\b/i);
    expect(importer).not.toMatch(/setTimeout/);
    expect(importer).not.toMatch(/for\s*\([^)]*attempt/i);
  });

  it("counts every connection attempt and every query", () => {
    expect(importer).toMatch(/mysqlAttempts \+= 1/);
    expect(importer).toMatch(/budget\.spent \+= 1/);
    expect(importer).toMatch(/of 100\/hour/);
    expect(importer).toMatch(/of 50\/hour/);
  });

  it("proves the credential cannot write before reading any data", () => {
    const assertAt = importer.indexOf("assertOrderSourceReadOnly");
    const firstRead = importer.indexOf("fetchCaseSourceRows");
    expect(assertAt).toBeGreaterThan(-1);
    expect(assertAt).toBeLessThan(firstRead);
  });

  it("keeps the source datetimes raw, so none acquires the process timezone", () => {
    expect(importer).toMatch(/dateStrings:\s*true/);
    expect(importer).toMatch(/supportBigNumbers:\s*true/);
    expect(importer).toMatch(/bigNumberStrings:\s*true/);
  });

  /**
   * NEVER TWO SERVERS AT ONCE. A concurrent probe hit `53300 too many
   * connections` during discovery, so the ordering is a rule: MySQL closed before
   * the order source opens, and that closed before the write connection opens.
   */
  it("closes each server's connection before opening the next", () => {
    const mysqlEnd = importer.indexOf("connection.end()");
    const sourceConnect = importer.indexOf("sourceClient.connect()");
    const sourceEnd = importer.indexOf("sourceClient.end()");
    const appConnect = importer.indexOf("appClient.connect()");
    expect(mysqlEnd).toBeGreaterThan(-1);
    expect(mysqlEnd).toBeLessThan(sourceConnect);
    expect(sourceEnd).toBeLessThan(appConnect);
  });

  /**
   * Checked as WRITES rather than as names. The importer's verification output
   * reads `sync_state` back to prove it gained no row, and a substring scan read
   * that proof as the thing it disproves — the same false positive a constraint
   * name about blankness caused in the 0022 schema test.
   */
  it("registers no schedule, worker or feed", () => {
    for (const term of ["cron", "setInterval", "watermark", "feed_key"]) {
      expect(importer.toLowerCase(), `${term} must not appear`).not.toContain(term.toLowerCase());
    }
    expect(importer).not.toMatch(/(INSERT\s+INTO|UPDATE)\s+cst_app\.sync_state/i);
    expect(importer).not.toMatch(/(INSERT\s+INTO|UPDATE)\s+cst_app\.automation/i);
  });

  it("is wired to npm as a manual command and nothing else", () => {
    const pkg = JSON.parse(read(join(ROOT, "package.json"))) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["import:marketplace-cases"]).toContain("scripts/import-marketplace-cases.mjs");
    const vercel = join(ROOT, "vercel.json");
    if (existsSync(vercel)) {
      expect(read(vercel)).not.toContain("marketplace-cases");
    }
  });
});

// ===========================================================================
describe("the readers only read", () => {
  it("the MySQL case reader contains no write verb and no DDL", () => {
    const source = code(read(SOURCE_READER));
    for (const verb of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "CREATE", "ALTER", "DROP", "REPLACE"]) {
      expect(source, `${verb} must not appear`).not.toMatch(new RegExp(`\\b${verb}\\b`));
    }
  });

  it("the order lookup contains no write verb", () => {
    const source = code(read(LOOKUP));
    for (const verb of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "CREATE", "ALTER", "DROP"]) {
      expect(source, `${verb} must not appear`).not.toMatch(new RegExp(`\\b${verb}\\b`));
    }
  });

  /**
   * A table name cannot be a bound parameter, so a passed value may only LOOK UP
   * a prepared statement. Interpolating one is injection through data.
   */
  /**
   * Checked against SQL-shaped interpolation only. A blanket "no ${table}
   * anywhere in a template" also matched the runaway guard's own ERROR MESSAGE,
   * which names the store deliberately — the message is the point of it.
   */
  it("selects a constant statement per store rather than building one", () => {
    const source = code(read(SOURCE_READER));
    expect(source).toMatch(/CASE_STATEMENTS\[table\]/);
    expect(source).not.toMatch(/FROM\s+\$\{/);
    expect(source).not.toMatch(/(SELECT|FROM|WHERE|JOIN)[^\n]*\$\{table\}/);
  });

  /**
   * BINDS EVERY VALUE, INTERPOLATING NONE — and the distinction this test had to
   * learn is that interpolating a PLACEHOLDER NUMBER is not interpolating a VALUE.
   *
   * The batched upsert generates `$1 .. $N` tuples, so its statement is built by
   * interpolation. That is safe: the only things it splices in are placeholder
   * indices and SQL fragments that are compile-time constants. Splicing a
   * caller's value, or a table or column name, is what must never happen.
   *
   * So the check strips the interpolations that are provably safe and then
   * requires nothing to be left. A NEW kind of interpolation fails this test,
   * which is the whole point — it has to be read and added here deliberately.
   */
  /** Backtick templates that actually contain SQL — not every string in the file. */
  function sqlTemplates(source: string): string[] {
    return [...source.matchAll(/`([^`]*)`/g)]
      .map((m) => m[1]!)
      .filter((body) => /\b(SELECT|INSERT\s+INTO|UPDATE\s+cst_app|ON CONFLICT|FROM)\b/.test(body));
  }

  /**
   * Inside a SQL template, the ONLY interpolation permitted is placeholder
   * generation and SQL fragments that are compile-time constants. The batched
   * upsert needs both: it builds `$1 .. $N` tuples and splices them between a
   * constant head and a constant conflict clause.
   */
  const SAFE_IN_SQL = [
    /\$\$\{[^}]*\}/g, // `$${base + i + 1}` — a placeholder index
    /\$\{cast\}/g, // the type cast that follows it
    /\$\{INSERT_HEAD\}/g,
    /\$\{CONFLICT_CLAUSE\}/g,
    /\$\{tuples\}/g,
  ];

  it("binds every value, interpolating none", () => {
    for (const path of [SOURCE_READER, LOOKUP, WRITER]) {
      const templates = sqlTemplates(code(read(path)));
      expect(templates.length, `${path} has no SQL template to check`).toBeGreaterThan(0);
      for (const template of templates) {
        let remaining = template;
        for (const safe of SAFE_IN_SQL) remaining = remaining.replace(safe, " ");
        expect(
          remaining,
          `${path} interpolates something unreviewed into SQL`,
        ).not.toMatch(/\$\{/);
      }
    }
  });

  /** And no identifier is ever interpolated, whatever the expression. */
  it("interpolates no table or column name into SQL", () => {
    for (const path of [SOURCE_READER, LOOKUP, WRITER]) {
      const source = code(read(path));
      for (const pattern of [
        /FROM\s+\$\{/,
        /JOIN\s+\$\{/,
        /INTO\s+\$\{/,
        /UPDATE\s+\$\{/,
        /SET\s+\$\{/,
        /ON CONFLICT\s*\(\s*\$\{/,
      ]) {
        expect(source, `${path} :: ${String(pattern)}`).not.toMatch(pattern);
      }
    }
  });

  it("throws at the runaway guard rather than importing a truncated store", () => {
    const source = read(SOURCE_READER);
    expect(source).toMatch(/at or past the \$\{limit\} guard/);
    expect(source).toMatch(/refusing to import a possibly truncated case set/);
  });
});

// ===========================================================================
describe("the domain layer stays pure", () => {
  it("imports no database, driver, pool or clock", () => {
    for (const path of [DOMAIN, EXTRACT]) {
      const source = code(read(path));
      expect(source, path).not.toMatch(/@\/lib\/db\//);
      expect(source, path).not.toMatch(/\bmysql2\b/);
      expect(source, path).not.toMatch(/\bpg\b/);
      expect(source, path).not.toMatch(/Date\.now\(\)/);
      expect(source, path).not.toMatch(/new Date\(/);
    }
  });

  it("adds no transport, recipient or outbound structure", () => {
    for (const path of [DOMAIN, EXTRACT, WRITER, SOURCE_READER, LOOKUP]) {
      const source = code(read(path)).toLowerCase();
      for (const term of ["recipient", "outbound", "transmit", "smtp", "webhook", "sendreply"]) {
        expect(source, `${term} in ${path}`).not.toContain(term);
      }
    }
  });
});
