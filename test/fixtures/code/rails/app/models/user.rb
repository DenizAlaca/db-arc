class User < ApplicationRecord
  belongs_to :account
  enum role: { member: 0, admin: 1, owner: 2 }
end
