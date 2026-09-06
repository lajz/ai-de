import { describe, expect, it } from 'vitest';

import { splitByFile, truncateDiff } from './diff.js';

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,1 @@
-const a = 1;
+const a = 2;
diff --git a/src/b.ts b/src/b.ts
index 333..444 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,1 +1,2 @@
 const b = 1;
+const c = 3;
`;

describe('splitByFile', () => {
  it('splits a multi-file diff and recovers the new path', () => {
    const parts = splitByFile(DIFF);
    expect(parts.map((p) => p.file)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(parts[0]!.chunk).toContain('+const a = 2;');
    expect(parts[1]!.chunk).toContain('+const c = 3;');
  });

  it('returns nothing for a non-diff string', () => {
    expect(splitByFile('just some text')).toEqual([]);
  });
});

describe('truncateDiff', () => {
  it('keeps everything when under budget', () => {
    const out = truncateDiff(DIFF, 10_000);
    expect(out.diff).toBe(DIFF);
    expect(out.truncatedFiles).toEqual([]);
  });

  it('drops whole files past the budget and names them', () => {
    const firstChunkBytes = Buffer.byteLength(splitByFile(DIFF)[0]!.chunk);
    const out = truncateDiff(DIFF, firstChunkBytes);
    expect(out.diff).toContain('src/a.ts');
    expect(out.diff).not.toContain('src/b.ts');
    expect(out.truncatedFiles).toEqual(['src/b.ts']);
  });
});
