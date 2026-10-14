using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;

namespace Shop.Models;

public enum OrderStatus
{
    Pending = 0,
    Shipped = 1,
    Delivered = 2
}

public abstract class BaseEntity
{
    public int Id { get; set; }
    public DateTime CreatedAt { get; set; }
}

public class Customer : BaseEntity
{
    [Required]
    [MaxLength(100)]
    public string Name { get; set; } = string.Empty;
    public string? Email { get; set; }
    public ICollection<Order> Orders { get; set; } = new List<Order>();
}

[Table("orders")]
public class Order : BaseEntity
{
    public decimal Total { get; set; }
    public OrderStatus Status { get; set; }
    public int CustomerId { get; set; }
    public virtual Customer Customer { get; set; } = null!;
    [Column("shipped_on")]
    public DateTime? ShippedAt { get; set; }

    [NotMapped]
    public string Display => $"{Id}";

    public void Ship() { ShippedAt = DateTime.UtcNow; }
}

public class Invoice
{
    public string Number { get; set; } = "";
    public int OrderRef { get; set; }
    [ForeignKey(nameof(OrderRef))]
    public Order Order { get; set; } = null!;
}
