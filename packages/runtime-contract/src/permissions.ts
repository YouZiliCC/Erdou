export type PermissionKind = "network" | "storage";

export interface Permission {
  kind: PermissionKind;
  granted: boolean;
}

export interface PermissionRequest {
  kind: PermissionKind;
  reason: string;
}
