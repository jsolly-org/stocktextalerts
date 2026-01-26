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

### 2. Data Massaging Detection Hook

**Event:** `afterFileEdit`  
**Priority:** High  
**Action:** Warn

**Purpose:** Detect validation/normalization logic (data massaging) in client/server code. Validation should only exist in forms and database schema.

**Patterns to Detect:**

#### String Transformations
- `.trim()`, `.trimStart()`, `.trimEnd()`
- `.toLowerCase()`, `.toUpperCase()`, `.toLocaleLowerCase()`, `.toLocaleUpperCase()`
- `.replace(/pattern/g, '')` (any regex replacement)
- `.replace(/\s+/g, ' ')` (normalize whitespace)
- `.replace(/\s/g, '')` (remove all whitespace)
- `.replace(/[^a-zA-Z0-9]/g, '')` (remove special chars)
- `.replace(/\D/g, '')` (remove non-digits)

#### Number Transformations
- `Math.floor()`, `Math.ceil()`, `Math.round()`, `Math.trunc()`
- `Math.min()`, `Math.max()`
- `parseInt()`, `parseFloat()`
- `Number()`, `+value`
- `.toFixed()`

#### Date/Time Transformations
- `new Date()`, `Date.parse()`
- Timezone normalization functions
- Date formatting methods

#### Type Coercion
- `Boolean()`, `String()`, `Number()`
- `Array.isArray(value) ? value : [value]`

#### Conditional Guards & Fallbacks
- `if (value == null)`, `if (value === null)`, `if (value === undefined)`
- `value || defaultValue`, `value ?? defaultValue`
- Optional chaining: `value?.trim()`, `value?.toLowerCase()`
- `if (value === '')`, `if (!value)`, `if (value.length === 0)`
- `value || ''`, `value || 'default'`
- `typeof value === 'string'`, `Array.isArray(value)`, `!isNaN(value)`, `instanceof` checks

#### Validation + Transformation Combos
- Regex test + replace: `if (/pattern/.test(value)) { value.replace(...) }`
- Validation functions followed by transforms: `isValidEmail()`, `isValidPhone()`, then transform
- Schema validation libraries with `.transform()` or `.preprocess()`: Zod, Yup, Joi
- Try-catch around parsing: `try { JSON.parse() } catch { defaultValue }`

#### Multi-Step Transformation Chains
- Multiple chained methods: `.trim().toLowerCase().replace()`
- Function composition: `pipe(trim, lowerCase, removeSpecialChars)`
- Array of transformers: `transformers.reduce((val, fn) => fn(val), value)`
- Conditional transformations: `value ? transform(value) : defaultValue`

#### Data Cleaning Utilities
- Function names: `sanitize()`, `normalize()`, `clean()`, `fix()`, `correct()`
- Format functions: `formatPhone()`, `formatEmail()`, `formatCurrency()`
- Remove functions: `removeWhitespace()`, `removeSpecialChars()`
- Library usage: `validator.js`, `lodash` transforms (`_.trim()`, `_.toLower()`), string libraries

#### Schema-Level Patterns
- Zod `.preprocess()`, `.transform()`
- Yup `.transform()`
- Custom schema middleware
- `.default('')`, `.default(0)`, `.default(null)`

#### Defensive Access Patterns
- `value?.property?.method()`
- `(value || {}).property`
- `value && value.property`
- `(array || []).map()`
- `Array.isArray(value) ? value : []`
- `value?.length ? value : []`

#### Error Recovery Patterns
- `value || fallback`, `value ?? fallback`
- `value && transform(value) || defaultValue`
- `value || tryAlternative() || defaultValue`

#### Format Detection & Correction
- `if (value.includes('@')) { /* email logic */ }`
- `if (/^\d+$/.test(value)) { /* number string */ }`
- `if (value.startsWith('http')) { /* URL logic */ }`

**Exclusions:**
- Code in `src/lib/forms/` directory (forms are allowed to have validation)
- Code in `supabase/migrations/` directory (schema definitions)
- Third-party webhook handlers (where normalization is required)

**Output Format:**
```json
{
  "warnings": [
    {
      "file": "src/pages/api/example.ts",
      "line": 42,
      "column": 10,
      "pattern": ".trim()",
      "message": "Data massaging detected: .trim() should only be used in forms or for external service data normalization"
    }
  ]
}
```

---

### 3. Defensive Programming Detection Hook

**Event:** `afterFileEdit`  
**Priority:** Medium  
**Action:** Warn

**Purpose:** Detect defensive programming patterns that add unnecessary checks for things guaranteed by types, database constraints, or system design.

**Patterns to Detect:**

#### Excessive Null/Undefined Checks
- `if (value == null)` on NOT NULL database columns
- `if (value === undefined)` on required function parameters
- `value ?? defaultValue` when TypeScript types guarantee non-null
- `value || fallback` when value is guaranteed to exist
- Optional chaining (`?.`) on properties that can't be null
- Multiple null checks for the same value in sequence
- Null checks on values from validated schemas

#### Type Guards for Guaranteed Types
- `typeof value === 'string'` when parameter is typed as `string`
- `Array.isArray(value)` when value is typed as `Array<T>`
- `instanceof` checks on values with known types
- `!isNaN(value)` when value is already a number type
- Type checks after type assertions
- Runtime type checks when compile-time types exist

#### Try-Catch for Non-Throwing Operations
- `try { value.trim() } catch {}` (trim never throws)
- `try { value.toLowerCase() } catch {}` (toLowerCase never throws)
- `try { array.map() } catch {}` (map doesn't throw for valid arrays)
- `try { object.property } catch {}` (property access doesn't throw)
- Empty catch blocks: `catch {}`, `catch (e) {}`
- Catch blocks that only log without rethrowing
- Catch blocks that return default values for unexpected errors

#### Redundant Validation Layers
- Validating after schema validation
- Checking constraints that database enforces
- Validating values from trusted sources (internal APIs, validated forms)
- Type checking after type-safe operations
- Checking format when database constraint ensures it
- Validating required fields that are NOT NULL
- Range checks when CHECK constraints exist
- Foreign key validation when DB enforces referential integrity

#### Defensive Defaults Everywhere
- `value || ''` when value is required/guaranteed
- `value ?? 0` when value is NOT NULL
- `(array || []).map()` when array is guaranteed to exist
- `(obj || {}).property` when object is required
- Default parameters for required arguments
- Fallback chains for values that must exist

#### Over-Checking Before Operations
- `if (value) { value.trim() }` (trim is safe on strings)
- `if (array) { array.map() }` when array is guaranteed
- `if (obj) { obj.property }` when object exists
- Length checks before operations that handle empty arrays
- Checking if function exists before calling
- Verifying properties exist before accessing (when guaranteed)

#### Error Handling That Masks Issues
- `try { db.query() } catch { return null }` (masks DB errors)
- `try { api.call() } catch { return [] }` (hides API failures)
- Catching all errors without logging context
- Returning default values for unexpected error types
- `catch (e)` without checking error type
- Catching errors that should propagate

#### Checking Database/System Guarantees
- Checking NOT NULL columns for null
- Validating CHECK constraint ranges
- Verifying foreign key relationships
- Checking UNIQUE constraints manually

**Output Format:**
```json
{
  "warnings": [
    {
      "file": "src/lib/example.ts",
      "line": 15,
      "column": 5,
      "pattern": "if (value == null)",
      "message": "Defensive check detected: value is from NOT NULL column, null check is unnecessary"
    }
  ]
}
```

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

### 6. File Size Limit Hook

**Event:** `afterFileEdit`  
**Priority:** Medium  
**Action:** Warn

**Purpose:** Enforce file size limit of ≤300 lines (AGENTS.md: "Keep files focused").

**Implementation:**
- Count lines in edited file
- If > 300 lines: warn and suggest extraction to utilities

**Output Format:**
```json
{
  "warnings": [
    {
      "file": "src/lib/example.ts",
      "line_count": 350,
      "message": "File exceeds 300 line limit. Consider extracting utilities to maintain DRY principles."
    }
  ]
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

### 8. Testing Framework Enforcement Hook

**Event:** `beforeShellExecution`  
**Priority:** High  
**Action:** Block

**Purpose:** Block Jest commands, enforce Vitest only.

**Commands to Block:**
- `jest` (any command starting with `jest`)
- `npx jest`
- `npm run test` if it runs Jest (check package.json scripts)
- `yarn jest`
- `pnpm jest`

**Package Installations to Block:**
- `npm install jest`
- `npm install @jest/*`
- `yarn add jest`
- `pnpm add jest`

**Output Format:**
```json
{
  "permission": "deny",
  "user_message": "Jest is not allowed. Use Vitest instead.",
  "agent_message": "According to AGENTS.md, only Vitest should be used for testing. Use 'npm run test' or 'vitest' instead."
}
```

---

### 9. Linting/Formatting Enforcement Hook

**Event:** `beforeShellExecution`  
**Priority:** High  
**Action:** Block

**Purpose:** Block Prettier/ESLint, enforce Biome only.

**Commands to Block:**
- `prettier` (any command)
- `eslint` (any command)
- `npx prettier`
- `npx eslint`
- `npm run format` if it runs Prettier
- `npm run lint` if it runs ESLint

**Package Installations to Block:**
- `npm install prettier`
- `npm install eslint`
- `npm install @prettier/*`
- `npm install @eslint/*`
- `yarn add prettier`
- `yarn add eslint`

**Output Format:**
```json
{
  "permission": "deny",
  "user_message": "Prettier/ESLint are not allowed. Use Biome instead.",
  "agent_message": "According to AGENTS.md, only Biome should be used for linting/formatting. Use 'biome check' or 'biome format' instead."
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
