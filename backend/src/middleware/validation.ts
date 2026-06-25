import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';

/**
 * Validates request body using a Zod schema.
 * Re-assigns req.body to the parsed result to support type coercion and default values.
 */
export const validateBody = (schema: ZodSchema) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      req.body = await schema.parseAsync(req.body);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          success: false,
          error: 'ইনপুট ভ্যালিডেশন ব্যর্থ হয়েছে।',
          details: error.issues.map((err: any) => ({
            field: err.path.join('.'),
            message: err.message,
          })),
        });
      }
      return res.status(500).json({ success: false, error: 'অভ্যন্তরীণ সার্ভার ত্রুটি।' });
    }
  };
};

/**
 * Validates request query parameters using a Zod schema.
 */
export const validateQuery = (schema: ZodSchema) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      req.query = await schema.parseAsync(req.query) as any;
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          success: false,
          error: 'ইনপুট ভ্যালিডেশন ব্যর্থ হয়েছে।',
          details: error.issues.map((err: any) => ({
            field: err.path.join('.'),
            message: err.message,
          })),
        });
      }
      return res.status(500).json({ success: false, error: 'অভ্যন্তরীণ সার্ভার ত্রুটি।' });
    }
  };
};

/**
 * Validates route parameters (req.params) using a Zod schema.
 */
export const validateParams = (schema: ZodSchema) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      req.params = await schema.parseAsync(req.params) as any;
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          success: false,
          error: 'ইনপুট ভ্যালিডেশন ব্যর্থ হয়েছে।',
          details: error.issues.map((err: any) => ({
            field: err.path.join('.'),
            message: err.message,
          })),
        });
      }
      return res.status(500).json({ success: false, error: 'অভ্যন্তরীণ সার্ভার ত্রুটি।' });
    }
  };
};
