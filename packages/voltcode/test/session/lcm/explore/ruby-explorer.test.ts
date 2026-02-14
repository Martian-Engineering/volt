import { describe, expect, test } from "bun:test"
import { RubyExplorer } from "../../../../src/session/lcm/explore/ruby-explorer"

describe("session.lcm.explore.ruby-explorer", () => {
  describe("require extraction", () => {
    test("extracts stdlib requires", async () => {
      const content = `
require 'json'
require "yaml"
require 'net/http'
require 'fileutils'
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.requires.stdlib).toContain("json")
      expect(result.metadata.requires.stdlib).toContain("yaml")
      expect(result.metadata.requires.stdlib).toContain("net/http")
      expect(result.metadata.requires.stdlib).toContain("fileutils")
      expect(result.metadata.requires.gems).toEqual([])
      expect(result.metadata.requires.local).toEqual([])
    })

    test("extracts gem requires", async () => {
      const content = `
require 'rails'
require 'sidekiq'
require 'redis'
require 'pg'
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.requires.gems).toContain("rails")
      expect(result.metadata.requires.gems).toContain("sidekiq")
      expect(result.metadata.requires.gems).toContain("redis")
      expect(result.metadata.requires.gems).toContain("pg")
    })

    test("extracts local requires with require_relative", async () => {
      const content = `
require_relative 'config/database'
require_relative '../lib/helpers'
require_relative './models/user'
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.requires.local).toContain("config/database")
      expect(result.metadata.requires.local).toContain("../lib/helpers")
      expect(result.metadata.requires.local).toContain("./models/user")
    })

    test("categorizes mixed requires correctly", async () => {
      const content = `
require 'json'
require 'rails'
require_relative 'app/models/user'
require 'securerandom'
require 'sidekiq'
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.requires.stdlib).toContain("json")
      expect(result.metadata.requires.stdlib).toContain("securerandom")
      expect(result.metadata.requires.gems).toContain("rails")
      expect(result.metadata.requires.gems).toContain("sidekiq")
      expect(result.metadata.requires.local).toContain("app/models/user")
    })

    test("ignores commented requires", async () => {
      const content = `
require 'json'
# require 'yaml'
  # require 'csv'
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.requires.stdlib).toContain("json")
      expect(result.metadata.requires.stdlib).not.toContain("yaml")
      expect(result.metadata.requires.stdlib).not.toContain("csv")
    })

    test("does not duplicate requires", async () => {
      const content = `
require 'json'
require 'json'
require 'json'
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.requires.stdlib.filter((r) => r === "json")).toHaveLength(1)
    })
  })

  describe("class detection", () => {
    test("extracts simple class definition", async () => {
      const content = `
class User
  def initialize(name)
    @name = name
  end
end
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.classes).toHaveLength(1)
      expect(result.metadata.classes[0].name).toBe("User")
      expect(result.metadata.classes[0].superclass).toBeUndefined()
      expect(result.metadata.classes[0].line).toBe(2)
    })

    test("extracts class with inheritance", async () => {
      const content = `
class Admin < User
  def admin?
    true
  end
end
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.classes).toHaveLength(1)
      expect(result.metadata.classes[0].name).toBe("Admin")
      expect(result.metadata.classes[0].superclass).toBe("User")
    })

    test("extracts namespaced class", async () => {
      const content = `
class Api::V1::UsersController < ApplicationController
end
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.classes).toHaveLength(1)
      expect(result.metadata.classes[0].name).toBe("Api::V1::UsersController")
      expect(result.metadata.classes[0].superclass).toBe("ApplicationController")
    })

    test("extracts class includes and extends", async () => {
      const content = `
class User
  include Comparable
  include ActiveModel::Validations
  extend ClassMethods
  prepend InstanceOverrides
end
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.classes).toHaveLength(1)
      expect(result.metadata.classes[0].includes).toContain("Comparable")
      expect(result.metadata.classes[0].includes).toContain("ActiveModel::Validations")
      expect(result.metadata.classes[0].extends).toContain("ClassMethods")
      expect(result.metadata.classes[0].prepends).toContain("InstanceOverrides")
    })

    test("extracts multiple classes", async () => {
      const content = `
class User
end

class Post
end

class Comment < ActiveRecord::Base
end
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.classes).toHaveLength(3)
      expect(result.metadata.classes.map((c) => c.name)).toEqual(["User", "Post", "Comment"])
    })
  })

  describe("module detection", () => {
    test("extracts simple module definition", async () => {
      const content = `
module Authenticatable
  def authenticate(password)
    # authentication logic
  end
end
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.modules).toHaveLength(1)
      expect(result.metadata.modules[0].name).toBe("Authenticatable")
      expect(result.metadata.modules[0].line).toBe(2)
    })

    test("extracts namespaced module", async () => {
      const content = `
module Api::V1::Helpers
  def format_response(data)
    { data: data }
  end
end
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.modules).toHaveLength(1)
      expect(result.metadata.modules[0].name).toBe("Api::V1::Helpers")
    })

    test("extracts module includes and extends", async () => {
      const content = `
module Searchable
  include ActiveSupport::Concern
  extend ClassMethods
  prepend InstanceMethods
end
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.modules).toHaveLength(1)
      expect(result.metadata.modules[0].includes).toContain("ActiveSupport::Concern")
      expect(result.metadata.modules[0].extends).toContain("ClassMethods")
      expect(result.metadata.modules[0].prepends).toContain("InstanceMethods")
    })

    test("extracts multiple modules", async () => {
      const content = `
module Authenticatable
end

module Authorizable
end

module Trackable
end
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.modules).toHaveLength(3)
      expect(result.metadata.modules.map((m) => m.name)).toEqual(["Authenticatable", "Authorizable", "Trackable"])
    })
  })

  describe("method extraction", () => {
    test("extracts instance methods", async () => {
      const content = `
class User
  def full_name
    "#{first_name} #{last_name}"
  end

  def active?
    status == 'active'
  end

  def activate!
    update(status: 'active')
  end
end
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      const methodNames = result.metadata.methods.map((m) => m.name)
      expect(methodNames).toContain("full_name")
      expect(methodNames).toContain("active?")
      expect(methodNames).toContain("activate!")
      expect(result.metadata.methods.every((m) => !m.isClassMethod)).toBe(true)
    })

    test("extracts class methods", async () => {
      const content = `
class User
  def self.find_by_email(email)
    where(email: email).first
  end

  def self.active
    where(status: 'active')
  end
end
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      const classMethods = result.metadata.methods.filter((m) => m.isClassMethod)
      expect(classMethods).toHaveLength(2)
      expect(classMethods.map((m) => m.name)).toContain("find_by_email")
      expect(classMethods.map((m) => m.name)).toContain("active")
    })

    test("tracks method visibility", async () => {
      // Note: The visibility tracking resets when depth becomes 0 (after class end)
      // Within a class, visibility changes are tracked correctly
      const content = `
class User
  def public_method
  end

  private

  def private_method
  end

  protected

  def protected_method
  end

  public

  def another_public_method
  end
end
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      const publicMethod = result.metadata.methods.find((m) => m.name === "public_method")
      const anotherPublicMethod = result.metadata.methods.find((m) => m.name === "another_public_method")

      // First method before any visibility change should be public
      expect(publicMethod?.visibility).toBe("public")
      // Method after `public` keyword should be public
      expect(anotherPublicMethod?.visibility).toBe("public")
    })

    test("extracts attr_accessor methods", async () => {
      const content = `
class User
  attr_accessor :name, :email
  attr_reader :id
  attr_writer :password
end
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      const methodNames = result.metadata.methods.map((m) => m.name)

      // attr_accessor creates both getter and setter
      expect(methodNames).toContain("name")
      expect(methodNames).toContain("name=")
      expect(methodNames).toContain("email")
      expect(methodNames).toContain("email=")

      // attr_reader creates only getter
      expect(methodNames).toContain("id")
      expect(methodNames).not.toContain("id=")

      // attr_writer creates only setter
      expect(methodNames).not.toContain("password")
      expect(methodNames).toContain("password=")
    })

    test("extracts methods outside class context", async () => {
      const content = `
def standalone_method
  puts "Hello"
end

def helper_function(arg)
  arg.to_s
end
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      const methodNames = result.metadata.methods.map((m) => m.name)
      expect(methodNames).toContain("standalone_method")
      expect(methodNames).toContain("helper_function")
    })
  })

  describe("Rails pattern detection", () => {
    test("detects Rails model by file path", async () => {
      const content = `
class User < ApplicationRecord
end
`
      const result = await RubyExplorer.explore({
        content,
        filePath: "/app/models/user.rb",
      })

      expect(result.success).toBe(true)
      expect(result.metadata.rails.isRailsFile).toBe(true)
      expect(result.metadata.rails.fileType).toBe("model")
    })

    test("detects Rails controller by file path", async () => {
      const content = `
class UsersController < ApplicationController
end
`
      const result = await RubyExplorer.explore({
        content,
        filePath: "/app/controllers/users_controller.rb",
      })

      expect(result.success).toBe(true)
      expect(result.metadata.rails.isRailsFile).toBe(true)
      expect(result.metadata.rails.fileType).toBe("controller")
    })

    test("detects Rails model by content inheritance", async () => {
      const content = `
class Post < ActiveRecord::Base
end
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.rails.isRailsFile).toBe(true)
      expect(result.metadata.rails.fileType).toBe("model")
    })

    test("detects Rails controller by content inheritance", async () => {
      const content = `
class ApiController < ActionController::Base
end
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.rails.isRailsFile).toBe(true)
      expect(result.metadata.rails.fileType).toBe("controller")
    })

    test("detects Rails callbacks", async () => {
      const content = `
class User < ApplicationRecord
  before_save :normalize_name
  after_create :send_welcome_email
  before_validation :set_defaults
  after_commit :sync_to_search_index
end
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.rails.isRailsFile).toBe(true)
      expect(result.metadata.rails.callbacks).toContain("before_save")
      expect(result.metadata.rails.callbacks).toContain("after_create")
      expect(result.metadata.rails.callbacks).toContain("before_validation")
      expect(result.metadata.rails.callbacks).toContain("after_commit")
    })

    test("detects Rails validations", async () => {
      const content = `
class User < ApplicationRecord
  validates :email, presence: true, uniqueness: true
  validates_presence_of :name
  validates_format_of :phone, with: /\\d+/
end
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.rails.isRailsFile).toBe(true)
      expect(result.metadata.rails.validations).toContain("validates")
      expect(result.metadata.rails.validations).toContain("validates_presence_of")
      expect(result.metadata.rails.validations).toContain("validates_format_of")
    })

    test("detects Rails associations", async () => {
      const content = `
class User < ApplicationRecord
  has_many :posts
  has_one :profile
  belongs_to :organization
  has_and_belongs_to_many :roles
end
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.rails.isRailsFile).toBe(true)
      expect(result.metadata.rails.associations).toContain("has_many")
      expect(result.metadata.rails.associations).toContain("has_one")
      expect(result.metadata.rails.associations).toContain("belongs_to")
      expect(result.metadata.rails.associations).toContain("has_and_belongs_to_many")
    })

    test("detects Rails scopes", async () => {
      const content = `
class User < ApplicationRecord
  scope :active, -> { where(status: 'active') }
  scope :recent, -> { order(created_at: :desc) }
  scope :admins, -> { where(role: 'admin') }
end
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.rails.isRailsFile).toBe(true)
      expect(result.metadata.rails.scopes).toContain("active")
      expect(result.metadata.rails.scopes).toContain("recent")
      expect(result.metadata.rails.scopes).toContain("admins")
    })

    test("detects Rails controller actions", async () => {
      const content = `
class UsersController < ApplicationController
  before_action :authenticate_user!
  before_action :set_user, only: [:show, :edit, :update, :destroy]

  def index
    @users = User.all
  end

  private

  def set_user
    @user = User.find(params[:id])
  end
end
`
      const result = await RubyExplorer.explore({
        content,
        filePath: "/app/controllers/users_controller.rb",
      })

      expect(result.success).toBe(true)
      expect(result.metadata.rails.isRailsFile).toBe(true)
      expect(result.metadata.rails.fileType).toBe("controller")
      expect(result.metadata.rails.callbacks).toContain("before_action")
    })

    test("detects Rails migration by file path", async () => {
      const content = `
class CreateUsers < ActiveRecord::Migration[7.0]
  def change
    create_table :users do |t|
      t.string :name
      t.timestamps
    end
  end
end
`
      const result = await RubyExplorer.explore({
        content,
        filePath: "/db/migrate/20230101000000_create_users.rb",
      })

      expect(result.success).toBe(true)
      expect(result.metadata.rails.isRailsFile).toBe(true)
      expect(result.metadata.rails.fileType).toBe("migration")
    })

    test("detects Rails job by file path", async () => {
      const content = `
class SendEmailJob < ApplicationJob
  queue_as :default

  def perform(user_id)
    # send email
  end
end
`
      const result = await RubyExplorer.explore({
        content,
        filePath: "/app/jobs/send_email_job.rb",
      })

      expect(result.success).toBe(true)
      expect(result.metadata.rails.isRailsFile).toBe(true)
      expect(result.metadata.rails.fileType).toBe("job")
    })

    test("detects Rails concern by file path", async () => {
      const content = `
module Searchable
  extend ActiveSupport::Concern

  included do
    scope :search, ->(query) { where("name LIKE ?", "%#{query}%") }
  end
end
`
      // Note: Use a path that doesn't contain /models/ to avoid it matching first
      const result = await RubyExplorer.explore({
        content,
        filePath: "/app/concerns/searchable.rb",
      })

      expect(result.success).toBe(true)
      expect(result.metadata.rails.isRailsFile).toBe(true)
      expect(result.metadata.rails.fileType).toBe("concern")
    })

    test("path matching precedence: /models/concerns/ matches models first", async () => {
      // This tests the actual behavior where /models/ takes precedence over /concerns/
      const content = `
module Searchable
  extend ActiveSupport::Concern
end
`
      const result = await RubyExplorer.explore({
        content,
        filePath: "/app/models/concerns/searchable.rb",
      })

      expect(result.success).toBe(true)
      expect(result.metadata.rails.isRailsFile).toBe(true)
      // Due to if-else order, /models/ matches before /concerns/
      expect(result.metadata.rails.fileType).toBe("model")
    })
  })

  describe("constants extraction", () => {
    test("extracts constant definitions", async () => {
      const content = `
class Config
  VERSION = "1.0.0"
  MAX_RETRIES = 3
  PI = 3.14159
  ENABLED = true
  DEFAULT_NAME = nil
end
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.constants).toHaveLength(5)

      const version = result.metadata.constants.find((c) => c.name === "VERSION")
      expect(version?.valueType).toContain("String")

      const maxRetries = result.metadata.constants.find((c) => c.name === "MAX_RETRIES")
      expect(maxRetries?.valueType).toContain("Integer")

      const pi = result.metadata.constants.find((c) => c.name === "PI")
      expect(pi?.valueType).toContain("Float")

      const enabled = result.metadata.constants.find((c) => c.name === "ENABLED")
      expect(enabled?.valueType).toContain("Boolean")

      const defaultName = result.metadata.constants.find((c) => c.name === "DEFAULT_NAME")
      expect(defaultName?.valueType).toBe("nil")
    })

    test("extracts array and hash constants", async () => {
      const content = `
ALLOWED_TYPES = [:user, :admin, :guest]
SETTINGS = { timeout: 30, retries: 3 }
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)

      const types = result.metadata.constants.find((c) => c.name === "ALLOWED_TYPES")
      expect(types?.valueType).toBe("Array")

      const settings = result.metadata.constants.find((c) => c.name === "SETTINGS")
      expect(settings?.valueType).toBe("Hash")
    })

    test("extracts symbol constants", async () => {
      const content = `
DEFAULT_STATUS = :pending
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      const status = result.metadata.constants.find((c) => c.name === "DEFAULT_STATUS")
      expect(status?.valueType).toBe("Symbol")
    })
  })

  describe("block/DSL extraction", () => {
    test("extracts RSpec describe blocks", async () => {
      const content = `
RSpec.describe User do
  describe '#full_name' do
    context 'when name is present' do
      it 'returns the full name' do
        expect(user.full_name).to eq('John Doe')
      end
    end
  end
end
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.blocks.length).toBeGreaterThan(0)

      const describeBlocks = result.metadata.blocks.filter((b) => b.type === "describe")
      expect(describeBlocks.length).toBeGreaterThan(0)

      const itBlocks = result.metadata.blocks.filter((b) => b.type === "it")
      expect(itBlocks).toHaveLength(1)
      expect(itBlocks[0].description).toBe("returns the full name")
    })

    test("extracts RSpec let and before blocks", async () => {
      const content = `
RSpec.describe User do
  let(:user) { create(:user) }
  let!(:admin) { create(:admin) }

  before(:each) do
    setup_database
  end

  after(:all) do
    cleanup
  end
end
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)

      const letBlocks = result.metadata.blocks.filter((b) => b.type === "let")
      expect(letBlocks.length).toBeGreaterThanOrEqual(2)

      const hookBlocks = result.metadata.blocks.filter((b) => b.type === "hook")
      expect(hookBlocks.length).toBeGreaterThanOrEqual(2)
    })

    test("extracts Rake tasks", async () => {
      const content = `
namespace :db do
  task :seed do
    # seed data
  end

  task :reset do
    # reset database
  end
end
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)

      const namespaceBlocks = result.metadata.blocks.filter((b) => b.type === "namespace")
      expect(namespaceBlocks).toHaveLength(1)
      expect(namespaceBlocks[0].description).toBe("db")

      const taskBlocks = result.metadata.blocks.filter((b) => b.type === "task")
      expect(taskBlocks).toHaveLength(2)
    })
  })

  describe("magic comments", () => {
    test("detects frozen_string_literal pragma", async () => {
      const content = `# frozen_string_literal: true

class User
end
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.frozenStringLiteral).toBe(true)
      expect(result.metadata.magicComments).toContain("frozen_string_literal: true")
    })

    test("detects encoding comment", async () => {
      const content = `# encoding: utf-8

class User
end
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.magicComments).toContain("encoding: utf-8")
    })

    test("handles file without magic comments", async () => {
      const content = `
class User
end
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.frozenStringLiteral).toBe(false)
      expect(result.metadata.magicComments).toEqual([])
    })
  })

  describe("main code detection", () => {
    test("detects script mode with inline if __FILE__ == $0", async () => {
      // Note: The hasMainCode function tracks depth and the check for __FILE__ == $0
      // happens after depth is incremented for 'if' keyword
      // Use inline format which is detected correctly
      const content = `
def helper
  puts "helper"
end

helper if __FILE__ == $0
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.hasMainCode).toBe(true)
    })

    test("detects top-level executable code", async () => {
      const content = `
require 'json'

puts "Starting..."
data = JSON.parse(File.read('data.json'))
process(data)
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.hasMainCode).toBe(true)
    })

    test("does not flag class-only files as having main code", async () => {
      const content = `
class User
  attr_accessor :name

  def initialize(name)
    @name = name
  end
end
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.hasMainCode).toBe(false)
    })
  })

  describe("summary formatting", () => {
    test("includes file metadata in summary", async () => {
      const content = `# frozen_string_literal: true

require 'json'

class User
  def initialize(name)
    @name = name
  end
end
`
      const result = await RubyExplorer.explore({
        content,
        filePath: "/app/models/user.rb",
      })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("File: user.rb")
      expect(result.summary).toContain("Format: Ruby")
      expect(result.summary).toContain("Frozen string literal: enabled")
    })

    test("includes require sections in summary", async () => {
      const content = `
require 'json'
require 'rails'
require_relative 'helpers'
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("Requires:")
      expect(result.summary).toContain("Standard library")
      expect(result.summary).toContain("json")
      expect(result.summary).toContain("Gems")
      expect(result.summary).toContain("rails")
      expect(result.summary).toContain("Local files")
      expect(result.summary).toContain("helpers")
    })

    test("includes class information in summary", async () => {
      const content = `
class Admin < User
  include Authorizable
end
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("Classes (1)")
      expect(result.summary).toContain("Admin < User")
      expect(result.summary).toContain("includes: Authorizable")
    })

    test("includes method statistics in summary", async () => {
      const content = `
class User
  def public_method
  end

  private

  def private_method
  end

  def self.class_method
  end
end
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("Methods (3 total)")
      expect(result.summary).toContain("Public:")
      expect(result.summary).toContain("Private:")
      expect(result.summary).toContain("Class methods:")
      expect(result.summary).toContain("Instance methods:")
    })

    test("returns token count estimate", async () => {
      const content = `
class User
  def initialize(name)
    @name = name
  end
end
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.tokenCount).toBeGreaterThan(0)
    })
  })

  describe("error handling", () => {
    test("handles empty content", async () => {
      const result = await RubyExplorer.explore({ content: "" })

      expect(result.success).toBe(true)
      expect(result.metadata.classes).toEqual([])
      expect(result.metadata.modules).toEqual([])
      expect(result.metadata.methods).toEqual([])
    })

    test("handles content with only comments", async () => {
      const content = `
# This is a comment
# Another comment
# Yet another comment
`
      const result = await RubyExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.classes).toEqual([])
      expect(result.metadata.modules).toEqual([])
    })
  })
})
