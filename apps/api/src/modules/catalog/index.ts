import { Router } from "express";
import type { AppContext } from "../../context";
import type { ModuleRoutes } from "../types";
import { registerCategories } from "./categories";
import { registerCollections } from "./collections";
import { registerAttributes } from "./attributes";
import { registerProducts } from "./products";
import { registerPublic } from "./public";

export function register(ctx: AppContext): ModuleRoutes {
  const admin = Router();
  registerCategories(ctx, admin);
  registerCollections(ctx, admin);
  registerAttributes(ctx, admin);
  registerProducts(ctx, admin);
  return { admin, public: registerPublic(ctx) };
}
