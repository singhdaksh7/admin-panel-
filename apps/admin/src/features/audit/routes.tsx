import type { RouteObject } from "react-router-dom";
import { Guard } from "../media/guard";
import { AuditLogs } from "./Audit";

export const routes: RouteObject[] = [
  {
    path: "audit-logs",
    element: (
      <Guard perm="audit.read">
        <AuditLogs />
      </Guard>
    ),
  },
];
