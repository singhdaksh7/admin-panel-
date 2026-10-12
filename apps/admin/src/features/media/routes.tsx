import type { RouteObject } from "react-router-dom";
import { Guard } from "./guard";
import { MediaLibrary } from "./MediaLibrary";

export const routes: RouteObject[] = [
  {
    path: "media",
    element: (
      <Guard perm="media.read">
        <MediaLibrary />
      </Guard>
    ),
  },
];
