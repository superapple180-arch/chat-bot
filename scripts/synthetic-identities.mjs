import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// Only the reviewed fixture files are rewritten, never production behavior or
// the private working copy. References and assertions use the same new labels.
export function syntheticIdentities(root) {
  const files = ['test/friend-agent.test.mjs', 'test/antigravity.test.mjs', 'test/integration.test.mjs', 'test/onebot.test.mjs', 'test/security-20261031.test.mjs', 'scripts/verify-friend-agent.mjs'];
  return files.map(file => {
    const absolute = path.join(root, file); let text = fs.readFileSync(absolute, 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), names = new Set();
    const visit = node => {
      if (ts.isPropertyAssignment(node) && ['nickname', 'remark', 'card'].includes(node.name.getText(source).replaceAll("'", '').replaceAll('"', '')) && ts.isStringLiteralLike(node.initializer)) {
        const value = node.initializer.text;
        if (/^[\u3400-\u9fff]{2,32}$/.test(value) && !/合成|测试/.test(value) && !['好友', '朋友', '本人', '自己', '主人', '管理员', '机器人', '联系人', '昵称', '备注', '名片'].includes(value)) names.add(value);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    const mapping = new Map([...names].map((name, index) => {
      const ordinal = '甲乙丙丁戊己庚辛壬癸'[index]; if (!ordinal) throw Error('FIXTURE_IDENTITIES_REQUIRE_REVIEW');
      return [name, '合成昵称' + ordinal];
    }));
    if (mapping.size) {
      const pattern = new RegExp([...mapping.keys()].sort((a, b) => b.length - a.length).join('|'), 'g');
      text = text.replace(pattern, name => mapping.get(name));
      fs.writeFileSync(absolute, '// Public fixture identities below are generated synthetic labels.\n' + text);
    }
    return { file, replacedLabels: mapping.size };
  });
}
