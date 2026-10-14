const mongoose = require('mongoose');
const { Schema } = mongoose;

const userSchema = new Schema({
  email: { type: String, required: true, unique: true },
  name: String,
  role: { type: String, enum: ['admin', 'editor', 'reader'], default: 'reader' },
  org: { type: Schema.Types.ObjectId, ref: 'Org' },
  tags: [String],
  address: {
    city: String,
    zip: { type: String },
  },
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
