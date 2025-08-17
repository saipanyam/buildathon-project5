#!/usr/bin/env node

const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

// Import our knowledge graph functionality
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Knowledge Graph CLI API',
    version: '1.0.0',
    endpoints: {
      '/status': 'GET - Check service status',
      '/connect': 'POST - Test Neo4j connection', 
      '/ingest': 'POST - Ingest documents or URLs',
      '/query': 'POST - Ask natural language questions (supports mode: auto/global/local)',
      '/stats': 'GET - Get graph statistics',
      '/communities': 'POST - Detect and analyze communities',
      '/clear': 'POST - Clear graph data'
    },
    documentation: 'https://github.com/saipanyam/buildathon-project5'
  });
});

// Status endpoint
app.get('/status', async (req, res) => {
  try {
    const { stdout } = await execPromise('node knowledge-graph.js status');
    res.json({ 
      status: 'success', 
      output: stdout,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'error', 
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Connect endpoint
app.post('/connect', async (req, res) => {
  try {
    const { stdout } = await execPromise('node knowledge-graph.js connect');
    res.json({ 
      status: 'success', 
      output: stdout,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'error', 
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Ingest endpoint
app.post('/ingest', async (req, res) => {
  try {
    const { files, urls, clear } = req.body;
    
    if (!files && !urls) {
      return res.status(400).json({
        status: 'error',
        message: 'Please provide files or urls to ingest'
      });
    }

    let command = 'node knowledge-graph.js ingest';
    
    if (files && files.length > 0) {
      command += ` -f ${files.join(' ')}`;
    }
    
    if (urls && urls.length > 0) {
      command += ` -u ${urls.join(' ')}`;
    }
    
    if (clear) {
      command += ' --clear';
    }

    const { stdout } = await execPromise(command);
    res.json({ 
      status: 'success', 
      output: stdout,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'error', 
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Query endpoint
app.post('/query', async (req, res) => {
  try {
    const { question, mode } = req.body;
    
    if (!question) {
      return res.status(400).json({
        status: 'error',
        message: 'Please provide a question'
      });
    }

    let command = `node knowledge-graph.js query "${question}"`;
    if (mode && ['auto', 'global', 'local'].includes(mode)) {
      command += ` --mode ${mode}`;
    }

    const { stdout } = await execPromise(command);
    res.json({ 
      status: 'success', 
      question: question,
      mode: mode || 'auto',
      answer: stdout,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'error', 
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Stats endpoint
app.get('/stats', async (req, res) => {
  try {
    const { stdout } = await execPromise('node knowledge-graph.js stats');
    res.json({ 
      status: 'success', 
      output: stdout,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'error', 
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Communities endpoint
app.post('/communities', async (req, res) => {
  try {
    const { stdout } = await execPromise('node knowledge-graph.js communities');
    res.json({ 
      status: 'success', 
      output: stdout,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'error', 
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Clear endpoint
app.post('/clear', async (req, res) => {
  try {
    const { stdout } = await execPromise('node knowledge-graph.js clear --confirm');
    res.json({ 
      status: 'success', 
      output: stdout,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'error', 
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Knowledge Graph API server running on port ${PORT}`);
  console.log(`📊 API Documentation: http://localhost:${PORT}/`);
});

module.exports = app;