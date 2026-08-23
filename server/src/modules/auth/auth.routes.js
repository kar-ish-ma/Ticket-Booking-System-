/**
 * auth.routes.js
 *
 * Owns the /auth router: request validation and Swagger annotations. No business logic —
 * everything delegates to auth.controller.js.
 */

import { Router } from 'express';
import { registerSchema, loginSchema } from 'shared/schemas/auth.schema.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import * as authController from './auth.controller.js';

export const authRouter = Router();

/**
 * @openapi
 * /api/v1/auth/register:
 *   post:
 *     summary: Register a new account
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password, name]
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string, minLength: 8 }
 *               name: { type: string }
 *               phone: { type: string }
 *               role: { type: string, enum: [ORGANISER, CUSTOMER] }
 *     responses:
 *       201:
 *         description: Account created; httpOnly access/refresh cookies set.
 *       409:
 *         description: Email already registered (EMAIL_TAKEN).
 *       422:
 *         description: Validation failed (VALIDATION_ERROR).
 */
authRouter.post('/register', validate(registerSchema), authController.register);

/**
 * @openapi
 * /api/v1/auth/login:
 *   post:
 *     summary: Log in with email and password
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string }
 *     responses:
 *       200:
 *         description: Logged in; httpOnly access/refresh cookies set.
 *       401:
 *         description: Wrong email or password (INVALID_CREDENTIALS).
 */
authRouter.post('/login', validate(loginSchema), authController.login);

/**
 * @openapi
 * /api/v1/auth/refresh:
 *   post:
 *     summary: Rotate the refresh token and issue a new access token
 *     description: >
 *       Reads the refresh token from its httpOnly cookie, not the request body. Reusing an
 *       already-rotated refresh token revokes every token descended from that login.
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: New cookies set.
 *       401:
 *         description: Missing, expired, invalid, or reused refresh token (REFRESH_INVALID).
 */
authRouter.post('/refresh', authController.refresh);

/**
 * @openapi
 * /api/v1/auth/logout:
 *   post:
 *     summary: Revoke the current refresh token and clear auth cookies
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: Always succeeds, even with no active session.
 */
authRouter.post('/logout', authController.logout);

/**
 * @openapi
 * /api/v1/auth/me:
 *   get:
 *     summary: Get the current authenticated user
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: The current user.
 *       401:
 *         description: No valid access token (UNAUTHENTICATED).
 */
authRouter.get('/me', requireAuth, authController.me);
