/**
 * events.controller.js
 *
 * Owns translating HTTP <-> events.service.js. No business logic and no SQL live here.
 */

import * as eventsService from './events.service.js';

/**
 * POST /api/v1/events
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function createEvent(req, res, next) {
  try {
    const event = await eventsService.createEvent(req.user.id, req.body);
    res.status(201).json({ success: true, data: { event }, error: null });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/v1/events/:id — requireOwnership has already run.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function updateEvent(req, res, next) {
  try {
    const event = await eventsService.updateEvent(req.params.id, req.body);
    res.status(200).json({ success: true, data: { event }, error: null });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/events
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function browseEvents(req, res, next) {
  try {
    const result = await eventsService.browseEvents(req.query);
    res.status(200).json({ success: true, data: result, error: null });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/events/:id
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function getEvent(req, res, next) {
  try {
    const event = await eventsService.getEvent(req.params.id);
    res.status(200).json({ success: true, data: { event }, error: null });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/events/:id/summary — requireOwnership has already run.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function getEventSummary(req, res, next) {
  try {
    const summary = await eventsService.getEventSummary(req.params.id);
    res.status(200).json({ success: true, data: summary, error: null });
  } catch (err) {
    next(err);
  }
}
