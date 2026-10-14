from django.db import models
from django.conf import settings


class Status(models.TextChoices):
    PENDING = 'pending', 'Pending'
    PAID = 'paid', 'Paid'
    SHIPPED = 'shipped', 'Shipped'


class TimeStamped(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        abstract = True


class Customer(TimeStamped):
    name = models.CharField(max_length=120)
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)

    class Meta:
        db_table = 'customers'


class Tag(models.Model):
    label = models.CharField(max_length=30)


class Order(TimeStamped):
    KIND_CHOICES = [
        ('web', 'Web'),
        ('store', 'Store'),
    ]
    code = models.CharField(max_length=20, primary_key=True)
    customer = models.ForeignKey(Customer, on_delete=models.CASCADE, related_name='orders')
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PENDING)
    kind = models.CharField(max_length=10, choices=KIND_CHOICES)
    referrer = models.ForeignKey('self', null=True, blank=True, on_delete=models.SET_NULL, db_column='ref_code')
    tags = models.ManyToManyField(Tag, blank=True)
    note = models.TextField(null=True)
