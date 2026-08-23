/**
 * venues.controller.js
 *
 * Owns translating HTTP <-> venues.service.js: reading validated params/body, shaping the
 * response envelope. No business logic and no SQL live here.
 */

import * as venuesService from './venues.service.js';

/**
 * POST /api/v1/venues
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function createVenue(req, res, next) {
  try {
    const venue = await venuesService.createVenue(req.body);
    res.status(201).json({ success: true, data: { venue }, error: null });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/venues
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function listVenues(req, res, next) {
  try {
    const venues = await venuesService.listVenues();
    res.status(200).json({ success: true, data: { venues }, error: null });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/venues/:id
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function getVenue(req, res, next) {
  try {
    const venue = await venuesService.getVenue(req.params.id);
    res.status(200).json({ success: true, data: { venue }, error: null });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/v1/venues/:id/categories
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function createCategory(req, res, next) {
  try {
    const category = await venuesService.createCategory(req.params.id, req.body);
    res.status(201).json({ success: true, data: { category }, error: null });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/v1/venues/:id/seats/bulk
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function bulkCreateSeats(req, res, next) {
  try {
    const seats = await venuesService.bulkCreateSeats(req.params.id, req.body.rows);
    res.status(201).json({ success: true, data: { seats }, error: null });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/venues/:id/layout
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function getVenueLayout(req, res, next) {
  try {
    const layout = await venuesService.getVenueLayout(req.params.id);
    res.status(200).json({ success: true, data: layout, error: null });
  } catch (err) {
    next(err);
  }
}
