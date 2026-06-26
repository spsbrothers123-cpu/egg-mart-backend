// src/models/Purchase.js
// Mongoose model for Purchase orders

const mongoose = require("mongoose");

const purchaseItemSchema = new mongoose.Schema(
  {
    productId:   { type: Number, required: true },
    productName: { type: String, required: true },
    category:    { type: String },
    unit:        { type: String },
    qty:         { type: Number, required: true, min: 0.001 },
    unitPrice:   { type: Number, required: true, min: 0 },
    totalPrice:  { type: Number },
  },
  { _id: false }
);

purchaseItemSchema.pre("save", function () {
  this.totalPrice = +(this.qty * this.unitPrice).toFixed(2);
});

const purchaseSchema = new mongoose.Schema(
  {
    invoiceNo:    { type: String, trim: true },
    supplier:     { type: String, trim: true },
    purchaseDate: { type: Date, default: Date.now },
    items:        { type: [purchaseItemSchema], required: true, validate: (v) => v.length > 0 },
    subtotal:     { type: Number },
    status:       { type: String, enum: ["pending", "received", "cancelled"], default: "pending" },
    notes:        { type: String },
    createdBy:    { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

// Auto-compute subtotal before save
purchaseSchema.pre("save", function (next) {
  this.items.forEach((item) => {
    item.totalPrice = +(item.qty * item.unitPrice).toFixed(2);
  });
  this.subtotal = +this.items.reduce((s, i) => s + i.totalPrice, 0).toFixed(2);
  next();
});

module.exports = mongoose.model("Purchase", purchaseSchema);
