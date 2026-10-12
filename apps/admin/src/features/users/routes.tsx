import type { RouteObject } from "react-router-dom";
import { Guard } from "../media/guard";
import { Users } from "./Users";

export const routes: RouteObject[] = [
  {
    path: "users",
    element: (
      <Guard perm="users.read">
        <Users />
      </Guard>
    ),
  },
];
