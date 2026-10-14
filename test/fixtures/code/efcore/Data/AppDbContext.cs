using Microsoft.EntityFrameworkCore;
using Shop.Models;

namespace Shop.Data;

public class AppDbContext : DbContext
{
    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }

    public DbSet<Customer> Customers { get; set; } = null!;
    public DbSet<Order> Orders => Set<Order>();
    public DbSet<Invoice> Invoices { get; set; }

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Invoice>(entity =>
        {
            entity.ToTable("billing_invoices");
            entity.HasKey(e => e.Number);
        });
    }
}
