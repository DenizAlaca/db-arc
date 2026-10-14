import os
DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.postgresql',
        'NAME': os.environ.get('DB_NAME', 'shop'),
        'USER': 'app',
        'PASSWORD': os.getenv('DB_PASS', 'secret'),
        'HOST': 'localhost',
        'PORT': '5432',
    }
}
