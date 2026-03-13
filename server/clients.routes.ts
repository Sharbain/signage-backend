/**
 * clients.routes.ts
 * Routes: /api/clients (CRUD, notes, custom fields, file attachments)
 *
 * Extracted from monolithic routes.ts.
 */

import type { Express } from "express";
import path from "path";
import fs from "fs";
import multer from "multer";
import { pool } from "../db";

// ---------------------------------------------------------------------------
// Multer config for client file attachments
// ---------------------------------------------------------------------------
const clientAttachmentsDir = path.join(process.cwd(), "uploads", "clients");
fs.mkdirSync(clientAttachmentsDir, { recursive: true });

const clientAttachmentStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, clientAttachmentsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `attachment_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  },
});

const clientAttachmentUpload = multer({
  storage: clientAttachmentStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowedMimes = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "image/jpeg",
      "image/png",
      "image/gif",
      "text/plain",
    ];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF, Word, Excel, PowerPoint, and image files are allowed"));
    }
  },
});

// ---------------------------------------------------------------------------
// Register routes
// ---------------------------------------------------------------------------
export function registerClientRoutes(app: Express) {

  // --- Clients CRUD ---

  app.get("/api/clients", async (_req, res) => {
    try {
      const result = await pool.query(`SELECT * FROM clients ORDER BY name ASC`);
      res.json(result.rows);
    } catch (err) {
      console.error("List clients error:", err);
      res.status(500).json({ error: "Failed to list clients" });
    }
  });

  app.get("/api/clients/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const clientResult = await pool.query(`SELECT * FROM clients WHERE id = $1`, [id]);
      if (clientResult.rowCount === 0) return res.status(404).json({ error: "Client not found" });

      const notesResult = await pool.query(
        `SELECT * FROM client_notes WHERE client_id = $1 ORDER BY created_at DESC`,
        [id],
      );
      res.json({ ...clientResult.rows[0], notes: notesResult.rows });
    } catch (err) {
      console.error("Get client error:", err);
      res.status(500).json({ error: "Failed to get client" });
    }
  });

  app.post("/api/clients", async (req, res) => {
    try {
      const { name, phone, email, company, position } = req.body;
      if (!name) return res.status(400).json({ error: "Name is required" });
      const result = await pool.query(
        `INSERT INTO clients (name, phone, email, company, position)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [name, phone || null, email || null, company || null, position || null],
      );
      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error("Create client error:", err);
      res.status(500).json({ error: "Failed to create client" });
    }
  });

  app.put("/api/clients/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { name, phone, email, company, position } = req.body;
      const result = await pool.query(
        `UPDATE clients SET
           name     = COALESCE($1, name),
           phone    = $2,
           email    = $3,
           company  = $4,
           position = $5
         WHERE id = $6 RETURNING *`,
        [name, phone || null, email || null, company || null, position || null, id],
      );
      if (result.rowCount === 0) return res.status(404).json({ error: "Client not found" });
      res.json(result.rows[0]);
    } catch (err) {
      console.error("Update client error:", err);
      res.status(500).json({ error: "Failed to update client" });
    }
  });

  app.delete("/api/clients/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const result = await pool.query(`DELETE FROM clients WHERE id = $1 RETURNING id`, [id]);
      if (result.rowCount === 0) return res.status(404).json({ error: "Client not found" });
      res.json({ success: true, deletedId: id });
    } catch (err) {
      console.error("Delete client error:", err);
      res.status(500).json({ error: "Failed to delete client" });
    }
  });

  // --- Notes ---

  app.get("/api/clients/:clientId/notes", async (req, res) => {
    try {
      const { clientId } = req.params;
      const result = await pool.query(
        `SELECT * FROM client_notes WHERE client_id = $1 ORDER BY created_at DESC`,
        [clientId],
      );
      res.json(result.rows);
    } catch (err) {
      console.error("List client notes error:", err);
      res.status(500).json({ error: "Failed to list notes" });
    }
  });

  app.post("/api/clients/:clientId/notes", async (req, res) => {
    try {
      const { clientId } = req.params;
      const { note } = req.body;
      if (!note) return res.status(400).json({ error: "Note content is required" });
      const result = await pool.query(
        `INSERT INTO client_notes (client_id, note) VALUES ($1, $2) RETURNING *`,
        [clientId, note],
      );
      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error("Create note error:", err);
      res.status(500).json({ error: "Failed to create note" });
    }
  });

  app.put("/api/clients/:clientId/notes/:noteId", async (req, res) => {
    try {
      const { noteId } = req.params;
      const { note } = req.body;
      const result = await pool.query(
        `UPDATE client_notes SET note = $1 WHERE id = $2 RETURNING *`,
        [note, noteId],
      );
      if (result.rowCount === 0) return res.status(404).json({ error: "Note not found" });
      res.json(result.rows[0]);
    } catch (err) {
      console.error("Update note error:", err);
      res.status(500).json({ error: "Failed to update note" });
    }
  });

  app.delete("/api/clients/:clientId/notes/:noteId", async (req, res) => {
    try {
      const { noteId } = req.params;
      const result = await pool.query(
        `DELETE FROM client_notes WHERE id = $1 RETURNING id`,
        [noteId],
      );
      if (result.rowCount === 0) return res.status(404).json({ error: "Note not found" });
      res.json({ success: true, deletedId: noteId });
    } catch (err) {
      console.error("Delete note error:", err);
      res.status(500).json({ error: "Failed to delete note" });
    }
  });

  // --- Custom fields ---

  app.get("/api/clients/:clientId/fields", async (req, res) => {
    try {
      const { clientId } = req.params;
      const result = await pool.query(
        `SELECT * FROM client_custom_fields WHERE client_id = $1 ORDER BY field_name`,
        [clientId],
      );
      res.json(result.rows);
    } catch (err) {
      console.error("List custom fields error:", err);
      res.status(500).json({ error: "Failed to list custom fields" });
    }
  });

  app.post("/api/clients/:clientId/fields", async (req, res) => {
    try {
      const { clientId } = req.params;
      const { fieldName, fieldValue } = req.body;
      if (!fieldName) return res.status(400).json({ error: "Field name is required" });
      const result = await pool.query(
        `INSERT INTO client_custom_fields (client_id, field_name, field_value)
         VALUES ($1, $2, $3) RETURNING *`,
        [clientId, fieldName, fieldValue || null],
      );
      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error("Create custom field error:", err);
      res.status(500).json({ error: "Failed to create custom field" });
    }
  });

  app.put("/api/clients/:clientId/fields/:fieldId", async (req, res) => {
    try {
      const { fieldId } = req.params;
      const { fieldName, fieldValue } = req.body;
      const result = await pool.query(
        `UPDATE client_custom_fields SET field_name = $1, field_value = $2 WHERE id = $3 RETURNING *`,
        [fieldName, fieldValue, fieldId],
      );
      if (result.rowCount === 0) return res.status(404).json({ error: "Custom field not found" });
      res.json(result.rows[0]);
    } catch (err) {
      console.error("Update custom field error:", err);
      res.status(500).json({ error: "Failed to update custom field" });
    }
  });

  app.delete("/api/clients/:clientId/fields/:fieldId", async (req, res) => {
    try {
      const { fieldId } = req.params;
      const result = await pool.query(
        `DELETE FROM client_custom_fields WHERE id = $1 RETURNING id`,
        [fieldId],
      );
      if (result.rowCount === 0) return res.status(404).json({ error: "Custom field not found" });
      res.json({ success: true, deletedId: fieldId });
    } catch (err) {
      console.error("Delete custom field error:", err);
      res.status(500).json({ error: "Failed to delete custom field" });
    }
  });

  // --- File attachments ---

  app.get("/api/clients/:clientId/attachments", async (req, res) => {
    try {
      const { clientId } = req.params;
      const result = await pool.query(
        `SELECT * FROM client_attachments WHERE client_id = $1 ORDER BY created_at DESC`,
        [clientId],
      );
      res.json(result.rows);
    } catch (err) {
      console.error("List attachments error:", err);
      res.status(500).json({ error: "Failed to list attachments" });
    }
  });

  app.post(
    "/api/clients/:clientId/attachments",
    clientAttachmentUpload.single("file"),
    async (req, res) => {
      try {
        const { clientId } = req.params;
        const file = req.file;
        if (!file) return res.status(400).json({ error: "No file uploaded" });
        const result = await pool.query(
          `INSERT INTO client_attachments (client_id, filename, original_name, mime_type, size)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [clientId, file.filename, file.originalname, file.mimetype, file.size],
        );
        res.status(201).json(result.rows[0]);
      } catch (err) {
        console.error("Upload attachment error:", err);
        res.status(500).json({ error: "Failed to upload attachment" });
      }
    },
  );

  app.get("/api/clients/:clientId/attachments/:attachmentId/download", async (req, res) => {
    try {
      const { clientId, attachmentId } = req.params;
      const result = await pool.query(
        `SELECT * FROM client_attachments WHERE id = $1 AND client_id = $2`,
        [attachmentId, clientId],
      );
      if (result.rowCount === 0) return res.status(404).json({ error: "Attachment not found" });

      const attachment = result.rows[0];
      const filePath = path.join(clientAttachmentsDir, attachment.filename);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found on disk" });

      res.setHeader("Content-Disposition", `attachment; filename="${attachment.original_name}"`);
      res.setHeader("Content-Type", attachment.mime_type);
      res.sendFile(filePath);
    } catch (err) {
      console.error("Download attachment error:", err);
      res.status(500).json({ error: "Failed to download attachment" });
    }
  });

  app.delete("/api/clients/:clientId/attachments/:attachmentId", async (req, res) => {
    try {
      const { clientId, attachmentId } = req.params;
      const result = await pool.query(
        `SELECT filename FROM client_attachments WHERE id = $1 AND client_id = $2`,
        [attachmentId, clientId],
      );
      if (result.rowCount === 0) return res.status(404).json({ error: "Attachment not found" });

      const filename = result.rows[0].filename;
      const filePath = path.join(clientAttachmentsDir, filename);
      await pool.query(
        `DELETE FROM client_attachments WHERE id = $1 AND client_id = $2`,
        [attachmentId, clientId],
      );
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

      res.json({ success: true, deletedId: attachmentId });
    } catch (err) {
      console.error("Delete attachment error:", err);
      res.status(500).json({ error: "Failed to delete attachment" });
    }
  });
}
