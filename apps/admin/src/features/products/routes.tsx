import type { RouteObject } from "react-router-dom";
import { Guard } from "./kit";
import { ProductForm } from "./ProductForm";
import { ProductList } from "./ProductList";

export const routes: RouteObject[] = [
  {
    path: "products",
    element: (
      <Guard perm="products.read">
        <ProductList />
      </Guard>
    ),
  },
  {
    path: "products/new",
    element: (
      <Guard perm={["products.read", "products.write"]}>
        <ProductForm />
      </Guard>
    ),
  },
  {
    path: "products/:id",
    element: (
      <Guard perm="products.read">
        <ProductForm />
      </Guard>
    ),
  },
];
