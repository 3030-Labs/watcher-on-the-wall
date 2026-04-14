/**
 * Tenant-scoped filesystem wrapper. Every file operation in hosted mode
 * goes through this class. Rejects path traversal and symlink attacks.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { join, resolve, relative, sep } from "node:path";

export class TenantFs {
  private readonly tenantRoot: string;

  constructor(tenantRoot: string) {
    this.tenantRoot = resolve(tenantRoot);
  }

  /** Validate that a resolved path is safely within the tenant root. */
  private assertSafe(resolvedPath: string): void {
    const canonical = resolve(resolvedPath);

    // Must be inside the tenant root
    if (canonical !== this.tenantRoot && !canonical.startsWith(this.tenantRoot + sep)) {
      throw new Error(`path escapes tenant root: ${resolvedPath}`);
    }

    // Walk every segment checking for symlinks
    const segments = relative(this.tenantRoot, canonical).split(sep);
    let current = this.tenantRoot;
    for (const seg of segments) {
      if (!seg) continue;
      current = join(current, seg);
      try {
        const st = lstatSync(current);
        if (st.isSymbolicLink()) {
          throw new Error(`symlink detected in path: ${current}`);
        }
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") break;
        throw err;
      }
    }
  }

  /** Resolve a relative path against the tenant root. */
  private abs(relativePath: string): string {
    return resolve(this.tenantRoot, relativePath);
  }

  readFile(relativePath: string): string {
    const p = this.abs(relativePath);
    this.assertSafe(p);
    return readFileSync(p, "utf8");
  }

  writeFile(relativePath: string, content: string): void {
    const p = this.abs(relativePath);
    this.assertSafe(p);
    const dir = resolve(p, "..");
    mkdirSync(dir, { recursive: true });
    writeFileSync(p, content, "utf8");
  }

  listDir(relativePath: string): string[] {
    const p = this.abs(relativePath);
    this.assertSafe(p);
    return readdirSync(p);
  }

  stat(relativePath: string): Stats {
    const p = this.abs(relativePath);
    this.assertSafe(p);
    return statSync(p);
  }

  exists(relativePath: string): boolean {
    const p = this.abs(relativePath);
    this.assertSafe(p);
    return existsSync(p);
  }

  remove(relativePath: string): void {
    const p = this.abs(relativePath);
    this.assertSafe(p);
    rmSync(p, { force: true });
  }

  /** Recursive directory walk, assertSafe on every entry. */
  walkDir(relativePath: string): string[] {
    const result: string[] = [];
    const walk = (rel: string): void => {
      const p = this.abs(rel);
      this.assertSafe(p);
      let entries: string[];
      try {
        entries = readdirSync(p);
      } catch {
        return;
      }
      for (const name of entries) {
        const childRel = join(rel, name);
        const childAbs = this.abs(childRel);
        this.assertSafe(childAbs);
        try {
          const st = statSync(childAbs);
          if (st.isDirectory()) {
            walk(childRel);
          } else {
            result.push(childRel);
          }
        } catch {
          // Skip unreadable
        }
      }
    };
    walk(relativePath);
    return result;
  }
}
