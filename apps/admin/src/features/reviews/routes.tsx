import type { RouteObject } from "react-router-dom";
import { Guard } from "../media/guard";
import { Reviews } from "./Reviews";

export const routes: RouteObject[] = [
  {
    path: "reviews",
    element: (
      <Guard perm="reviews.read">
        <Reviews />
      </Guard>
    ),
  },
];
