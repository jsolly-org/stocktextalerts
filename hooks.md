# Cursor Hooks Specification

This document specifies hooks to implement for enforcing code quality and AGENTS.md standards.

## Hook Configuration Structure

All hooks should be added to `.cursor/hooks.json` in the following format:

```json
{
  "version": 1,
  "hooks": {
    "hookEventName": [
      {
        "command": ".cursor/hooks/script-name.sh",
        "timeout": 30
      }
    ]
  }
}
```

---

## Hook Specifications

### 1. Empty Folder Cleanup Hook

**Event:** `afterFileEdit`  
**Priority:** Low  
**Action:** Informational

**Purpose:** Remove empty folders from the project after file edits.

**Implementation:**
- Scan project for empty directories
- Remove empty directories recursively
- Log removed directories

**Output:** None required (fire and forget)

---

### 4. Generated File Protection Hook

**Event:** `beforeReadFile` (blocking) or `afterFileEdit` (warning)  
**Priority:** High  
**Action:** Block or Warn

**Purpose:** Prevent modifications to auto-generated files.

**Files to Protect:**
- `src/lib/db/generated/database.types.ts` (auto-generated from Supabase schema)

**Implementation:**
- Check if file path matches protected pattern
- If `beforeReadFile`: return `{ "permission": "deny", "user_message": "This file is auto-generated. Regenerate using Supabase CLI instead." }`
- If `afterFileEdit`: warn that file should not be edited directly

**Output Format (beforeReadFile):**
```json
{
  "permission": "deny",
  "user_message": "File src/lib/db/generated/database.types.ts is auto-generated. Regenerate using: supabase gen types typescript --local > src/lib/db/generated/database.types.ts"
}
```

**Output Format (afterFileEdit):**
```json
{
  "warnings": [
    {
      "file": "src/lib/db/generated/database.types.ts",
      "message": "This file is auto-generated. Changes will be overwritten. Regenerate using Supabase CLI instead."
    }
  ]
}
```

---

### 5. Migration File Constraint Hook

**Event:** `afterFileEdit`  
**Priority:** High  
**Action:** Block

**Purpose:** Enforce that only the initial migration file can be modified. Block creation of new migration files.

**Implementation:**
- Detect edits in `supabase/migrations/` directory
- If file is NOT `20250101000000_initial_schema.sql`: block or warn
- Allow only modifications to existing `20250101000000_initial_schema.sql`

**Pattern to Match:**
- File path: `supabase/migrations/*.sql`
- Block if filename is NOT `20250101000000_initial_schema.sql`

**Output Format:**
```json
{
  "permission": "deny",
  "user_message": "New migration files are not allowed. Only modify supabase/migrations/20250101000000_initial_schema.sql",
  "agent_message": "According to AGENTS.md, only the initial migration file should be modified. Do not create new migration files."
}
```

---

### 7. Import Path Enforcement Hook

**Event:** `afterFileEdit`  
**Priority:** Medium  
**Action:** Warn

**Purpose:** Enforce relative imports only (no `@` style imports).

**Patterns to Detect:**
- `import ... from '@/...'`
- `import ... from "@/..."`
- `require('@/...')`

**Exclusions:**
- None (strict enforcement)

**Output Format:**
```json
{
  "warnings": [
    {
      "file": "src/pages/example.ts",
      "line": 5,
      "column": 20,
      "pattern": "import { x } from '@/lib/...'",
      "message": "Use relative imports instead of @ style. Change to: import { x } from '../lib/...'"
    }
  ]
}
```

---

### 10. Error Checking Pattern Hook

**Event:** `afterFileEdit`  
**Priority:** Medium  
**Action:** Warn

**Purpose:** Detect improper error checking patterns.

**Patterns to Detect:**
- `.includes()` for error type detection: `error.message.includes('...')`
- Empty catch blocks: `catch {}`, `catch (e) {}`
- String matching on error messages instead of structured properties

**Preferred Patterns:**
- `error.code`, `error.status`, `error.name`
- Structured error properties

**Output Format:**
```json
{
  "warnings": [
    {
      "file": "src/lib/example.ts",
      "line": 25,
      "column": 15,
      "pattern": "error.message.includes('...')",
      "message": "Use structured error properties (error.code, error.status) instead of string matching on error messages"
    },
    {
      "file": "src/lib/example.ts",
      "line": 30,
      "column": 10,
      "pattern": "catch {}",
      "message": "Empty catch block detected. Either handle the error properly or let it propagate."
    }
  ]
}
```

---

### 11. Logging Enforcement Hook

**Event:** `afterFileEdit`  
**Priority:** Medium  
**Action:** Warn

**Purpose:** Ensure structured logger usage from `src/lib/logging.ts`.

**Patterns to Detect:**
- Direct `console.log()`, `console.warn()`, `console.error()` usage
- Missing context objects in logger calls: `logInfo('message')` without context
- Empty context objects: `logInfo('message', {})`
- Wrong log levels (error/warn for expected rejections)

**Required Patterns:**
- `logInfo(message, context)`, `logWarn(message, context)`, `logError(message, context, error)`
- Named context objects (not `{}` or `undefined`)

**Output Format:**
```json
{
  "warnings": [
    {
      "file": "src/pages/api/example.ts",
      "line": 42,
      "column": 5,
      "pattern": "console.log(...)",
      "message": "Use structured logger from src/lib/logging.ts instead: logInfo(message, context)"
    },
    {
      "file": "src/pages/api/example.ts",
      "line": 50,
      "column": 5,
      "pattern": "logInfo('message')",
      "message": "Logger calls must include a named context object: logInfo('message', { key: value })"
    }
  ]
}
```

---

### 12. Environment Variable Validation Hook

**Event:** `afterFileEdit`  
**Priority:** Medium  
**Action:** Warn

**Purpose:** Detect presence checks for required environment variables in source files.

**Patterns to Detect:**
- `if (!process.env.REQUIRED_VAR)`
- `if (process.env.REQUIRED_VAR === undefined)`
- `process.env.REQUIRED_VAR || throw new Error(...)`
- `process.env.REQUIRED_VAR ?? defaultValue`

**Exclusions:**
- Code in `src/middleware.ts` (where env var validation is allowed)
- Format/type validation (e.g., `RESEND_API_KEY.startsWith('re_')`)
- Optional env vars (e.g., `EMAIL_REPLY_TO`, `TIMEZONE_CACHE_BUSTER`)

**Output Format:**
```json
{
  "warnings": [
    {
      "file": "src/lib/example.ts",
      "line": 10,
      "column": 5,
      "pattern": "if (!process.env.REQUIRED_VAR)",
      "message": "Required environment variables are validated in src/middleware.ts. Remove presence checks from source files."
    }
  ]
}
```

---

### 13. Browser Polyfill Detection Hook

**Event:** `afterFileEdit`  
**Priority:** Low  
**Action:** Warn

**Purpose:** Detect unnecessary browser polyfills for well-supported APIs.

**Patterns to Detect:**
- Try-catch blocks for modern browser APIs: `try { fetch() } catch {}`
- Feature detection for: `fetch`, `URL`, `AbortController`, `TextEncoder`, `TextDecoder`, `crypto.randomUUID()`
- Polyfill imports: `import 'polyfill-fetch'`, `import 'whatwg-fetch'`

**Exclusions:**
- Server-side polyfills (e.g., `@js-temporal/polyfill` for Node.js)
- Legitimate error handling (e.g., `sessionStorage` throwing `SecurityError` in private browsing)

**Output Format:**
```json
{
  "warnings": [
    {
      "file": "src/lib/example.ts",
      "line": 15,
      "column": 5,
      "pattern": "try { fetch() } catch {}",
      "message": "fetch is well-supported and won't throw in supported environments. Remove unnecessary try-catch."
    }
  ]
}
```

---

### 14. Compatibility Layer Detection Hook

**Event:** `afterFileEdit`  
**Priority:** Low  
**Action:** Warn

**Purpose:** Detect shims, adapters, deprecations, or re-exports for legacy behavior.

**Patterns to Detect:**
- Function names: `shim`, `adapter`, `deprecated`, `legacy`
- File names: `*shim*`, `*adapter*`, `*deprecated*`, `*legacy*`, `*compat*`
- Re-exports for backwards compatibility
- Compatibility wrappers

**Output Format:**
```json
{
  "warnings": [
    {
      "file": "src/lib/example-shim.ts",
      "message": "Compatibility layers are not allowed. Remove legacy code instead of preserving it."
    }
  ]
}
```

---

### 15. Icon Usage Enforcement Hook

**Event:** `afterFileEdit`  
**Priority:** Low  
**Action:** Warn

**Purpose:** Enforce correct icon usage patterns for Astro vs Vue files.

**For `.astro` files:**
- Must use: `Icon` from `astro-icon/components`
- Block: SVG imports with `?component`
- Block: Inline `<svg>` markup

**For `.vue` files:**
- Must use: SVG imports with `?component` suffix
- Block: `Icon` from `astro-icon/components`
- Block: Inline `<svg>` markup
- Icons must be in `src/icons/` directory

**Patterns to Detect:**
- In `.astro`: `import Icon from '...svg?component'` (wrong)
- In `.vue`: `import { Icon } from 'astro-icon/components'` (wrong)
- Inline `<svg>` in templates
- Icons imported from outside `src/icons/`

**Output Format:**
```json
{
  "warnings": [
    {
      "file": "src/components/Example.astro",
      "line": 5,
      "column": 10,
      "pattern": "import Icon from '...svg?component'",
      "message": "In .astro files, use Icon from 'astro-icon/components', not SVG component imports"
    },
    {
      "file": "src/components/Example.vue",
      "line": 3,
      "column": 10,
      "pattern": "import { Icon } from 'astro-icon/components'",
      "message": "In .vue files, import SVGs from src/icons/ with ?component suffix, not astro-icon/components"
    }
  ]
}
```

---

### 16. Type Annotation Pattern Hook

**Event:** `afterFileEdit`  
**Priority:** Low  
**Action:** Warn

**Purpose:** Detect tuple/array indexing for types.

**Patterns to Detect:**
- `Parameters<T>[0]`, `Parameters<T>[1]`
- `ReturnType<T>[0]`
- Array indexing on type utilities

**Preferred Pattern:**
- Direct type annotations: `export const POST: APIRoute = async ({ ... }) => {`

**Output Format:**
```json
{
  "warnings": [
    {
      "file": "src/pages/api/example.ts",
      "line": 10,
      "column": 30,
      "pattern": "Parameters<APIRoute>[0]",
      "message": "Avoid tuple indexing for types. Use direct type annotations instead: export const POST: APIRoute = async ({ ... }) => {"
    }
  ]
}
```

---

### 17. Section Comment Format Hook

**Event:** `afterFileEdit`  
**Priority:** Low  
**Action:** Warn

**Purpose:** Enforce section comment format.

**Required Formats:**
- Single-line: `/* ============= Section Title ============= */`
- Multi-line:
  ```text
  /* =============
  Comment Title
  ============= */
  ```

**Patterns to Detect:**
- Section comments that don't match the format
- Missing `=============` separators
- Incorrect spacing

**Output Format:**
```json
{
  "warnings": [
    {
      "file": "src/lib/example.ts",
      "line": 20,
      "column": 1,
      "pattern": "/* Section Title */",
      "message": "Section comments must use format: /* ============= Section Title ============= */"
    }
  ]
}
```

---

### 18. Migration Command Blocking Hook

**Event:** `beforeShellExecution`  
**Priority:** High  
**Action:** Block

**Purpose:** Block Supabase migration creation commands.

**Commands to Block:**
- `supabase migration new *`
- `supabase migration create *`
- Any command that creates new migration files

**Allowed:**
- Editing existing migration file directly
- `supabase gen types` (type generation)

**Output Format:**
```json
{
  "permission": "deny",
  "user_message": "New migration files are not allowed. Only modify supabase/migrations/20250101000000_initial_schema.sql",
  "agent_message": "According to AGENTS.md, only the initial migration file should be modified. Edit the existing migration file instead of creating new ones."
}
```

---

### 19. Prompt Validation Hook

**Event:** `beforeSubmitPrompt`  
**Priority:** Medium  
**Action:** Warn or Block

**Purpose:** Detect prompts requesting disallowed patterns.

**Patterns to Detect in Prompt:**
- "compatibility layer", "backwards compatibility", "shim", "adapter"
- "browser polyfill" for modern APIs
- "Jest" or "use Jest"
- "Prettier" or "ESLint" or "use Prettier/ESLint"
- "new migration" or "create migration"
- "edit database.types.ts" or "modify generated types"

**Output Format:**
```json
{
  "continue": false,
  "user_message": "This prompt requests patterns that violate AGENTS.md standards. Please revise your request."
}
```

---

## Implementation Notes

### Hook Script Template

Each hook script should:
1. Read JSON input from stdin
2. Parse the input according to the hook event schema
3. Perform detection/validation
4. Output JSON result to stdout
5. Exit with code 0 (success), 2 (block), or other (fail-open)

### Example Hook Script Structure

```bash
#!/bin/bash
# Read input
input=$(cat)
# Parse JSON (using jq or similar)
# Perform checks
# Output JSON result
echo '{"warnings": [...]}'
exit 0
```

### Priority Implementation Order

1. **High Priority (Implement First):**
   - Generated file protection (#4)
   - Migration file constraints (#5)
   - Testing framework enforcement (#8)
   - Linting/formatting enforcement (#9)
   - Migration command blocking (#18)

2. **Medium Priority:**
   - Data massaging detection (#2)
   - Import path enforcement (#7)
   - Error checking patterns (#10)
   - Logging enforcement (#11)
   - Environment variable validation (#12)
   - File size limits (#6)
   - Defensive programming detection (#3)

3. **Low Priority:**
   - Browser polyfill detection (#13)
   - Compatibility layer detection (#14)
   - Icon usage enforcement (#15)
   - Type annotation patterns (#16)
   - Section comment format (#17)
   - Empty folder cleanup (#1)
   - Prompt validation (#19)
