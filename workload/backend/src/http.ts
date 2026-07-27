import type { Request, Response, NextFunction } from "express";
import { HttpError, errorBody } from "./errors.js";

export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void handler(req, res, next).catch(next);
  };
}

export function errorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof HttpError) {
    res.status(err.status).json(errorBody(err));
    return;
  }

  if (err instanceof SyntaxError && "body" in err) {
    const error = new HttpError(400, "bad_request", "Malformed JSON request body");
    res.status(error.status).json(errorBody(error));
    return;
  }

  const message = err instanceof Error ? err.message : "Unexpected server error";
  res.status(500).json({ error: { code: "upstream_unavailable", message } });
}
