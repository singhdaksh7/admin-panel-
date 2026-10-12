import type { RouteObject } from "react-router-dom";
import { Guard } from "../media/guard";
import { Settings } from "./Settings";

export const routes: RouteObject[] = [
  {
    path: "settings",
    element: (
      <Guard perm="settings.read">
        <Settings />
      </Guard>
    ),
  },
];
