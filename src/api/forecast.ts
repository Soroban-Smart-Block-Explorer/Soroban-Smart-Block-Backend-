// src/api/forecast.ts
import express from 'express';
import { prisma } from '../db';
import { getForecast, getAnomalyForecast, trainModel, retrainModel, deleteModel, compareModels } from '../indexer/forecast';

const router = express.Router();

// GET /api/v1/predict/forecast
router.post('/predict/forecast', async (req, res) => {
  const { metric, granularity, horizon, model_type, confidence_level, include_features, include_history } = req.body;
  try {
    const forecast = await getForecast(metric, granularity, horizon, model_type, confidence_level, include_features, include_history);
    res.json(forecast);
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate forecast' });
  }
});

// GET /api/v1/predict/ensemble
router.get('/predict/ensemble', async (req, res) => {
  try {
    const ensemble = await getForecast('ensemble');
    res.json(ensemble);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch ensemble forecast' });
  }
});

// GET /api/v1/predict/ensemble/{metric}
router.get('/predict/ensemble/:metric', async (req, res) => {
  const { metric } = req.params;
  try {
    const ensemble = await getForecast(metric);
    res.json(ensemble);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch ensemble forecast for metric' });
  }
});

// GET /api/v1/predict/{model_id}/predictions
router.get('/predict/:model_id/predictions', async (req, res) => {
  const { model_id } = req.params;
  try {
    const predictions = await getPredictions(model_id);
    res.json(predictions);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch predictions for model' });
  }
});

// GET /api/v1/predict/{model_id}/features
router.get('/predict/:model_id/features', async (req, res) => {
  const { model_id } = req.params;
  try {
    const features = await getFeatureImportance(model_id);
    res.json(features);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch feature importance for model' });
  }
});

// GET /api/v1/predict/models
router.get('/predict/models', async (req, res) => {
  try {
    const models = await listModels();
    res.json(models);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch model list' });
  }
});

// GET /api/v1/predict/models/{model_id}
router.get('/predict/models/:model_id', async (req, res) => {
  const { model_id } = req.params;
  try {
    const modelDetails = await getModelDetails(model_id);
    res.json(modelDetails);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch model details' });
  }
});

// POST /api/v1/predict/models
router.post('/predict/models', async (req, res) => {
  try {
    const newModel = await trainModel(req.body);
    res.status(201).json(newModel);
  } catch (error) {
    res.status(500).json({ error: 'Failed to train model' });
  }
});

// POST /api/v1/predict/models/{model_id}/retrain
router.post('/predict/models/:model_id/retrain', async (req, res) => {
  const { model_id } = req.params;
  try {
    const retrainedModel = await retrainModel(model_id);
    res.json(retrainedModel);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrain model' });
  }
});

// DELETE /api/v1/predict/models/{model_id}
export const forecastRouter = router;