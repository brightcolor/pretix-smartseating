from django import template

register = template.Library()


@register.inclusion_tag("pretix_smartseating/shop/seat_selector.html", takes_context=True)
def smartseating_selector(context):
    return {"event": context.get("event")}

