// src/api/forecast.ts
import express from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { getForecast, trainModel, retrainModel, deleteModel } from '../indexer/forecast';

declare function getPredictions(modelId: string): Promise<any>;
declare function getFeatureImportance(modelId: string): Promise<any>;
declare function listModels(): Promise<any>;
declare function getModelDetails(modelId: string): Promise<any>;

const router = express.Router();

// GET /api/v1/predict/forecast
router.post(
  '/predict/forecast',
  asyncHandler(async (req, res) => {
    const {
      metric,
      granularity,
      horizon,
      model_type,
      confidence_level,
      include_features,
      include_history,
    } = req.body;
    const forecast = await getForecast(
      metric,
      granularity,
      horizon,
      model_type,
      confidence_level,
      include_features,
      include_history,
    );
    res.json(forecast);
  }),
);

// GET /api/v1/predict/ensemble
router.get(
  '/predict/ensemble',
  asyncHandler(async (_req, res) => {
    const ensemble = await getForecast('ensemble');
    res.json(ensemble);
  }),
);

// GET /api/v1/predict/ensemble/{metric}
router.get(
  '/predict/ensemble/:metric',
  asyncHandler(async (req, res) => {
    const { metric } = req.params;
    const ensemble = await getForecast(metric);
    res.json(ensemble);
  }),
);

// GET /api/v1/predict/{model_id}/predictions
router.get(
  '/predict/:model_id/predictions',
  asyncHandler(async (req, res) => {
    const { model_id } = req.params;
    const predictions = await getPredictions(model_id);
    res.json(predictions);
  }),
);

// GET /api/v1/predict/{model_id}/features
router.get(
  '/predict/:model_id/features',
  asyncHandler(async (req, res) => {
    const { model_id } = req.params;
    const features = await getFeatureImportance(model_id);
    res.json(features);
  }),
);

// GET /api/v1/predict/models
router.get(
  '/predict/models',
  asyncHandler(async (_req, res) => {
    const models = await listModels();
    res.json(models);
  }),
);

// GET /api/v1/predict/models/{model_id}
router.get(
  '/predict/models/:model_id',
  asyncHandler(async (req, res) => {
    const { model_id } = req.params;
    const modelDetails = await getModelDetails(model_id);
    res.json(modelDetails);
  }),
);

// POST /api/v1/predict/models
router.post(
  '/predict/models',
  asyncHandler(async (req, res) => {
    const newModel = await trainModel(req.body);
    res.status(201).json(newModel);
  }),
);

// POST /api/v1/predict/models/{model_id}/retrain
router.post(
  '/predict/models/:model_id/retrain',
  asyncHandler(async (req, res) => {
    const { model_id } = req.params;
    const retrainedModel = await retrainModel(model_id);
    res.json(retrainedModel);
  }),
);

// DELETE /api/v1/predict/models/{model_id}
router.delete(
  '/predict/models/:model_id',
  asyncHandler(async (req, res) => {
    const { model_id } = req.params;
    const result = await deleteModel(model_id);
    res.json(result);
  }),
);

export default router;
