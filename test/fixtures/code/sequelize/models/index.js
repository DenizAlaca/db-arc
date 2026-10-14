const { Sequelize, DataTypes, Model } = require('sequelize');
const sequelize = new Sequelize('sqlite::memory:');

const User = sequelize.define('User', {
  email: { type: DataTypes.STRING(160), allowNull: false, unique: true },
  status: { type: DataTypes.ENUM('active', 'banned'), defaultValue: 'active' },
  displayName: DataTypes.STRING,
}, { tableName: 'users', underscored: true });

class Post extends Model {}
Post.init({
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  title: { type: DataTypes.STRING, allowNull: false },
  body: DataTypes.TEXT,
}, { sequelize, modelName: 'Post', tableName: 'posts' });

const Comment = sequelize.define('Comment', {
  text: DataTypes.TEXT,
  postId: { type: DataTypes.UUID, references: { model: 'posts', key: 'id' } },
}, { timestamps: false });

Post.belongsTo(User, { foreignKey: 'authorId' });
User.hasMany(Comment, { foreignKey: 'userId' });

module.exports = { User, Post, Comment };
