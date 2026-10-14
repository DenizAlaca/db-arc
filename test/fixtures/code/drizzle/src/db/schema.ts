import { pgTable, pgEnum, serial, varchar, integer, timestamp, text, primaryKey } from 'drizzle-orm/pg-core';

export const roleEnum = pgEnum('role', ['admin', 'member', 'guest']);

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 256 }).notNull(),
  role: roleEnum('role').default('member').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  authorId: integer('author_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  title: text('title'),
});

export const postLikes = pgTable('post_likes', {
  postId: integer('post_id').notNull().references(() => posts.id),
  userId: integer('user_id').notNull().references(() => users.id),
}, (t) => ({
  pk: primaryKey({ columns: [t.postId, t.userId] }),
}));
