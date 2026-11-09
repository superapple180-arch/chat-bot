export function isReleaseFile(name) {
  return /^chat-bot-[a-zA-Z0-9._-]+\.(?:exe|dmg|zip|deb|AppImage)(?:\.blockmap)?$/.test(name) || /^latest-(?:win32|darwin|linux)-(?:x64|arm64)(?:-mac|-linux)?\.yml$/.test(name);
}
