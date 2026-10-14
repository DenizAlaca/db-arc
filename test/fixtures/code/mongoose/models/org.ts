import { Schema, model } from 'mongoose';

const OrgSchema = new Schema({
  name: { type: String, required: true },
  plan: { type: String, enum: ['free', 'team'] },
  members: [{ type: Schema.Types.ObjectId, ref: 'User' }],
});

export const Org = model('Org', OrgSchema, 'organizations');
