export const ROLE_PERMISSIONS = {
  admin: {
    all: true
  },
  restricted: {
    viewDevices: true,
    editAssignedDevices: true,
    viewAssignedGroups: true,
    cannotPublishContent: true
  },
  uploader: {
    uploadContent: true,
    requestPublish: true
  }
} as const;

export type Role = keyof typeof ROLE_PERMISSIONS;

export function hasPermission(role: Role, permission: string): boolean {
  const perms = ROLE_PERMISSIONS[role];
  if (!perms) return false;
  if ('all' in perms && perms.all) return true;
  return permission in perms && (perms as Record<string, boolean>)[permission] === true;
}

export function isAdmin(role: Role): boolean {
  return role === 'admin';
}
