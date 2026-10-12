import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import apiRoutes from './routes/api';
import { MessagingService } from './services/messaging';

dotenv.config({ override: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = 3000;

// Middlewares
app.use(cors());
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true }));

// Store Socket.io instance on app for access in routes
app.set('io', io);

// Convenient alias for dev tools
app.get(['/dev', '/dev/'], (req, res) => {
  res.redirect('/dev/db-manager.html');
});

// Serve static frontend from public/ (automatically covers public/dev)
const publicDir = path.join(process.cwd(), 'public');
app.use(express.static(publicDir));

// Mount API routes
app.use('/api', apiRoutes);

// WebSocket messaging setup
MessagingService.setupSocketMessaging(io);

// SPA Fallback
app.get('*', (req, res) => {
  // Prevent missing API or Dev routes from returning index.html
  if (req.path.startsWith('/api') || req.path.startsWith('/dev')) {
    return res.status(404).json({ error: 'Not found' });
  }
  
  // Otherwise, serve the SPA for standard frontend routes
  res.sendFile(path.join(publicDir, 'index.html'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 GreenSignalAI Server running at http://0.0.0.0:${PORT}`);
});
