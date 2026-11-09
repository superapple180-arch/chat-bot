import path from 'node:path';

// Desktop supplies these roots; CLI callers retain their current layout.
export const codePath = (...parts: string[]) => path.resolve(process.env.QQ_BOT_CODE_ROOT ?? process.cwd(), ...parts);
export const componentPath = (...parts: string[]) => path.resolve(process.env.QQ_BOT_COMPONENT_ROOT ?? process.cwd(), ...parts);
export const pythonPath = () => process.env.QQ_BOT_PYTHON ?? componentPath('runtime/voice-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
export const canonicalPath = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;

export function hookArgument(value: string) {
  if (/[\r\n\0]/.test(value)) throw Error('INVALID_HOOK_PATH');
  if (process.platform === 'win32') {
    if (/["%]/.test(value)) throw Error('INVALID_HOOK_PATH');
    return `"${value}"`;
  }
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
