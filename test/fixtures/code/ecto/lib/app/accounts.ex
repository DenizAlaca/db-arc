defmodule App.Accounts.Org do
  use Ecto.Schema

  schema "orgs" do
    field :name, :string
    has_many :users, App.Accounts.User
    timestamps()
  end
end

defmodule App.Accounts.User do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id
  schema "users" do
    field :email, :string
    field :role, Ecto.Enum, values: [:admin, :member]
    field :confirmed_at, :naive_datetime
    belongs_to :org, App.Accounts.Org, type: :id
    belongs_to :inviter, App.Accounts.User, foreign_key: :invited_by_id
    many_to_many :teams, App.Accounts.Team, join_through: "users_teams"
    timestamps(type: :utc_datetime)
  end

  def changeset(user, attrs) do
    user |> cast(attrs, [:email])
  end
end
