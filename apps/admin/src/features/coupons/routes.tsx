import type { RouteObject } from "react-router-dom";
import { Guard } from "../../routes";
import { CouponForm, CouponList } from "./Coupons";

export const routes: RouteObject[] = [
  {
    path: "coupons",
    element: (
      <Guard perm="coupons.read">
        <CouponList />
      </Guard>
    ),
  },
  {
    path: "coupons/new",
    element: (
      <Guard perm={["coupons.read", "coupons.write"]}>
        <CouponForm />
      </Guard>
    ),
  },
  {
    path: "coupons/:id",
    element: (
      <Guard perm="coupons.read">
        <CouponForm />
      </Guard>
    ),
  },
];
