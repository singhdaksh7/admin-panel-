import type { RouteObject } from "react-router-dom";
import { Guard } from "../media/guard";
import { Roles } from "./Roles";

export const routes: RouteObject[] = [
  {
    path: "roles",
    element: (
      <Guard perm="users.read">
        <Roles />
      </Guard>
    ),
  },
];
