const PATH_WHITELIST = /^[A-Za-z0-9_./\\:\- ]+$/;

export function validatePathStrict(p: string, label: string): void {
  if (!PATH_WHITELIST.test(p)) {
    throw new Error(`${label} contains disallowed characters: ${p}`);
  }
}
