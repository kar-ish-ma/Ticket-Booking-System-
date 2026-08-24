/**
 * shows.controller.js
 *
 * Owns translating HTTP <-> shows.service.js. No business logic and no SQL live here.
 */

import * as showsService from './shows.service.js';

/**
 * POST /api/v1/events/:eventId/shows — requireOwnership (on the event) has already run.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function createShow(req, res, next) {
  try {
    const result = await showsService.createShow(req.params.eventId, req.body);
    res.status(201).json({ success: true, data: result, error: null });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/events/:eventId/shows
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function listShowsByEvent(req, res, next) {
  try {
    const shows = await showsService.listShowsByEvent(req.params.eventId);
    res.status(200).json({ success: true, data: { shows }, error: null });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/shows/:id
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function getShow(req, res, next) {
  try {
    const show = await showsService.getShow(req.params.id);
    res.status(200).json({ success: true, data: { show }, error: null });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/v1/shows/:id/publish — requireOwnership (via the show's event) has already run.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function publishShow(req, res, next) {
  try {
    const result = await showsService.publishShow(req.params.id);
    res.status(200).json({ success: true, data: result, error: null });
  } catch (err) {
    next(err);
  }
}
