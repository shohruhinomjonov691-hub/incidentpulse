import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("first deploy and hardening update install the same root-private, validated sudoers copy", () => {
  const deploy = readFileSync(new URL("../../../docs/DEPLOY.md", import.meta.url), "utf8");
  const blocks = [...deploy.matchAll(/```bash\n([\s\S]*?)\n```/g)]
    .map((match) => match[1]?.split("\nsudo -l")[0])
    .filter((block) => block?.includes('visudo -cf "$sudoers_file"'));
  expect(blocks).toHaveLength(2);
  expect(blocks[0]).toBe(blocks[1]);
  expect(blocks[0]).toMatch(
    /set -eu\n.*test "\$\(id -u\)" -eq 0\n.*umask 077\n.*mktemp -d[^\n]*\n[\s\S]*chmod 0700 "\$sudoers_dir"\n[\s\S]*render-sudoers\.ts[^\n]* > "\$sudoers_file"\n\s*visudo -cf "\$sudoers_file"\n\s*install -m 0440 -o root -g root "\$sudoers_file"/,
  );
});
