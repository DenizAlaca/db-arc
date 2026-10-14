ActiveRecord::Schema[7.1].define(version: 2024_01_01_000000) do
  enable_extension "plpgsql"

  create_table "accounts", force: :cascade do |t|
    t.string "name", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
  end

  create_table "users", force: :cascade do |t|
    t.string "email", limit: 255, null: false
    t.integer "role", default: 0
    t.references "account", null: false, foreign_key: true
    t.timestamps null: false
    t.index ["email"], name: "index_users_on_email", unique: true
  end

  create_table "posts", id: :uuid, force: :cascade do |t|
    t.string "title"
    t.text "body"
    t.bigint "author_id", null: false
    t.string "tags", array: true
  end

  create_table "posts_tags", id: false, force: :cascade do |t|
    t.uuid "post_id"
    t.bigint "tag_id"
  end

  add_foreign_key "posts", "users", column: "author_id"
end
