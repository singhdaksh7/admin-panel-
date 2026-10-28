import type { RouteObject } from "react-router-dom";
import { Guard } from "../media/guard";
import { Notifications } from "./Notifications";

export const routes: RouteObject[] = [
  {
    path: "notifications",
    element: (
      <Guard perm="settings.read">
        <Notifications />
      </Guard>
    ),
  },
];
