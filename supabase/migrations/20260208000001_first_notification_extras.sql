ALTER TABLE public.users
ADD COLUMN first_notification_include_news BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.users
ADD COLUMN first_notification_include_rumors BOOLEAN NOT NULL DEFAULT false;

